import { describe, expect, it } from 'vitest';
import type { ActionApprovedPayload } from '@clientops/contracts';
import {
  assertAppendOnlyOperation,
  AUDIT_IMMUTABILITY_TRIGGER_SQL,
  AuditImmutabilityViolationError,
  buildAuditEvent,
  FORBIDDEN_AUDIT_KEYS,
  MAX_AUDIT_STRING_LENGTH,
  sanitizeAuditPayload,
  sanitizeApprovalComment,
} from './index.js';

describe('Phase 4 Audit Package Suite', () => {
  const orgId = '10000000-0000-4000-8000-000000000001';
  const proposalId = '20000000-0000-4000-8000-000000000002';
  const actorId = '30000000-0000-4000-8000-000000000003';

  describe('Sanitization & Secret Redaction', () => {
    it('redacts all forbidden secret keys recursively', () => {
      const sensitivePayload = {
        taskTitle: 'Safe Task',
        authorization: 'Bearer super-secret-jwt-token',
        api_key: 'sk-1234567890abcdef',
        nested: {
          password: 'db_password_123',
          aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          safeDetail: 'Safe nested detail',
        },
      };

      const sanitized = sanitizeAuditPayload(sensitivePayload);
      expect(sanitized['authorization']).toBe('[REDACTED]');
      expect(sanitized['api_key']).toBe('[REDACTED]');

      expect(FORBIDDEN_AUDIT_KEYS.has('password')).toBe(true);
      expect(FORBIDDEN_AUDIT_KEYS.has('authorization')).toBe(true);
      expect(FORBIDDEN_AUDIT_KEYS.has('api_key')).toBe(true);

      const nested = sanitized['nested'] as Record<string, unknown>;
      expect(nested['password']).toBe('[REDACTED]');
      expect(nested['aws_secret_access_key']).toBe('[REDACTED]');
      expect(nested['safeDetail']).toBe('Safe nested detail');
      expect(sanitized['taskTitle']).toBe('Safe Task');
    });

    it('truncates unbounded string contents to MAX_AUDIT_STRING_LENGTH', () => {
      const massiveString = 'A'.repeat(MAX_AUDIT_STRING_LENGTH + 200);
      const payload = { prompt: massiveString };

      const sanitized = sanitizeAuditPayload(payload);
      const promptVal = sanitized['prompt'] as string;
      expect(promptVal.length).toBeLessThan(massiveString.length);
      expect(promptVal).toContain('[TRUNCATED]');
    });

    it('redacts raw Error objects and stacks completely', () => {
      const err = new Error(
        'Database connection failed at /secret/path/pool.ts:45',
      );
      err.stack = 'Secret stack trace with server file paths';

      const sanitized = sanitizeAuditPayload({ error: err });
      expect(sanitized['error']).toBe('[ERROR_OBJECT_REDACTED]');
      expect(sanitized).not.toHaveProperty('stack');
    });

    it('redacts secret-shaped content in allowed string fields (defense-in-depth)', () => {
      const payloadWithStringSecrets = {
        comment:
          'Approved with bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token and AKIAIOSFODNN7EXAMPLE',
        reason:
          'password=supersecret db=postgres://user:pass@db.local:5432/test file=/workspaces/clientops-command/secret.txt',
      };

      const sanitized = sanitizeAuditPayload(payloadWithStringSecrets);
      const comment = sanitized['comment'] as string;
      const reason = sanitized['reason'] as string;

      expect(comment).toContain('[REDACTED_TOKEN]');
      expect(comment).toContain('[REDACTED_AWS_KEY]');
      expect(comment).not.toContain('eyJhbG');
      expect(comment).not.toContain('AKIAIOSFODNN7EXAMPLE');

      expect(reason).toContain('password=[REDACTED]');
      expect(reason).toContain('postgres://[REDACTED]@host');
      expect(reason).toContain('[REDACTED_PATH]');
      expect(reason).not.toContain('supersecret');
      expect(reason).not.toContain('/workspaces/');
    });
  });

  describe('buildAuditEvent', () => {
    it('constructs an AuditEvent with validated allowlisted payload and server timestamp', () => {
      const bindingHash = 'b'.repeat(64);
      const event = buildAuditEvent({
        organizationId: orgId,
        actionProposalId: proposalId,
        eventType: 'ACTION_APPROVED',
        actorId,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: bindingHash,
        correlationId: 'req-corr-456',
        payload: {
          actionProposalId: proposalId,
          actorId,
          actorRole: 'operator',
          decidedAt: new Date().toISOString(),
          approvalBindingHash: bindingHash,
          comment: 'Approved recovery task',
        },
      });

      expect(event.organizationId).toBe(orgId);
      expect(event.actionProposalId).toBe(proposalId);
      expect(event.eventType).toBe('ACTION_APPROVED');
      expect(event.actorId).toBe(actorId);
      expect(event.parameterHash).toBe('a'.repeat(64));
      expect(event.approvalBindingHash).toBe(bindingHash);
      expect(event.payload).toMatchObject({
        actionProposalId: proposalId,
        actorId,
        actorRole: 'operator',
        comment: 'Approved recovery task',
      });
      expect(event.occurredAt).toBeDefined();
    });

    it('rejects viewer role in approval audit payload', () => {
      const bindingHash = 'b'.repeat(64);
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          actionProposalId: proposalId,
          eventType: 'ACTION_APPROVED',
          actorId,
          payload: {
            actionProposalId: proposalId,
            actorId,
            actorRole: 'viewer' as unknown as 'admin',
            decidedAt: new Date().toISOString(),
            approvalBindingHash: bindingHash,
          },
        }),
      ).toThrow();
    });

    it('rejects mismatched eventType and payload pairing', () => {
      const executionFailedPayload = {
        actionProposalId: proposalId,
        executionId: '80000000-0000-4000-8000-000000000008',
        errorCode: 'INTERNAL_EXECUTION_ERROR',
        failureSummary: 'Internal error',
        failedAt: new Date().toISOString(),
      };

      // Mismatch: eventType ACTION_APPROVED with ExecutionFailedPayload
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          actionProposalId: proposalId,
          eventType: 'ACTION_APPROVED',
          actorId,
          payload: executionFailedPayload as unknown as Record<string, unknown>,
        } as unknown as Parameters<typeof buildAuditEvent>[0]),
      ).toThrow();
    });

    it('rejects arbitrary unallowlisted model/provider payloads', () => {
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          actionProposalId: proposalId,
          eventType: 'ACTION_APPROVED',
          actorId,
          payload: {
            rawPrompt: 'Tell me the secret database credentials',
            chainOfThought: 'I am reasoning about this now...',
            arbitraryField: 12345,
          } as unknown as ActionApprovedPayload,
        }),
      ).toThrow();
    });

    it('32. top-level/payload IDs must agree on valid construction', () => {
      const bindingHash = 'c'.repeat(64);
      const event = buildAuditEvent({
        organizationId: orgId,
        eventType: 'ACTION_APPROVED',
        payload: {
          actionProposalId: proposalId,
          actorId,
          actorRole: 'operator',
          decidedAt: new Date().toISOString(),
          approvalBindingHash: bindingHash,
        },
      });

      expect(event.actionProposalId).toBe(proposalId);
      expect(event.actorId).toBe(actorId);
      expect(event.approvalBindingHash).toBe(bindingHash);
    });

    it('33. mismatched actorId rejected', () => {
      const bindingHash = 'c'.repeat(64);
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          actorId: '99999999-9999-4000-8000-999999999999', // Mismatched with payload
          eventType: 'ACTION_APPROVED',
          payload: {
            actionProposalId: proposalId,
            actorId,
            actorRole: 'operator',
            decidedAt: new Date().toISOString(),
            approvalBindingHash: bindingHash,
          },
        }),
      ).toThrow(/Cross-field identity mismatch.*actorId/);
    });

    it('34. mismatched proposalId rejected', () => {
      const bindingHash = 'c'.repeat(64);
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          actionProposalId: '99999999-9999-4000-8000-999999999999', // Mismatched
          eventType: 'ACTION_APPROVED',
          payload: {
            actionProposalId: proposalId,
            actorId,
            actorRole: 'operator',
            decidedAt: new Date().toISOString(),
            approvalBindingHash: bindingHash,
          },
        }),
      ).toThrow(/Cross-field identity mismatch.*actionProposalId/);
    });

    it('35. mismatched binding hash rejected', () => {
      const bindingHash = 'c'.repeat(64);
      expect(() =>
        buildAuditEvent({
          organizationId: orgId,
          approvalBindingHash: 'd'.repeat(64), // Mismatched
          eventType: 'ACTION_APPROVED',
          payload: {
            actionProposalId: proposalId,
            actorId,
            actorRole: 'operator',
            decidedAt: new Date().toISOString(),
            approvalBindingHash: bindingHash,
          },
        }),
      ).toThrow(/Cross-field identity mismatch.*approvalBindingHash/);
    });

    it('36. secret-shaped approval comment safely redacted before persistence', () => {
      const dangerousComment =
        'Approved by admin with basic dXNlcjpwYXNz and {"token":"secret-token-123"} file=/workspaces/clientops/secret.key';
      const sanitized = sanitizeApprovalComment(dangerousComment);

      expect(sanitized).toBeDefined();
      expect(sanitized).toContain('[REDACTED_AUTH]');
      expect(sanitized).toContain('"token":"[REDACTED]"');
      expect(sanitized).toContain('[REDACTED_PATH]');
      expect(sanitized).not.toContain('secret-token-123');
      expect(sanitized).not.toContain('dXNlcjpwYXNz');
      expect(sanitized).not.toContain('/workspaces/');
    });
  });

  describe('Append-Only Immutability Enforcement', () => {
    it('permits INSERT operations and rejects UPDATE or DELETE', () => {
      expect(() => assertAppendOnlyOperation('INSERT')).not.toThrow();

      expect(() => assertAppendOnlyOperation('UPDATE')).toThrow(
        AuditImmutabilityViolationError,
      );
      expect(() => assertAppendOnlyOperation('DELETE')).toThrow(
        AuditImmutabilityViolationError,
      );
    });

    it('defines a valid PostgreSQL trigger preventing UPDATE or DELETE', () => {
      expect(AUDIT_IMMUTABILITY_TRIGGER_SQL).toContain(
        'CREATE OR REPLACE FUNCTION prevent_audit_events_modification()',
      );
      expect(AUDIT_IMMUTABILITY_TRIGGER_SQL).toContain(
        'BEFORE UPDATE OR DELETE ON audit_events',
      );
      expect(AUDIT_IMMUTABILITY_TRIGGER_SQL).toContain(
        'Audit records are append-only',
      );
    });
  });
});
