import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ActionExecutionRecordSchema,
  ActionProposalSchema,
  CreateActionProposalInputSchema,
  ActionApprovedPayloadSchema,
  ActionDeniedPayloadSchema,
  ActionStatusSchema,
  ActionTypeSchema,
  ApprovalDecisionSchema,
  ApprovalRecordSchema,
  AuditEventSchema,
  AuditEventTypeSchema,
  ExecutionAuthorizationSchema,
  ExecutionResultSchema,
  ModelActionProposalInputSchema,
  PolicyDecisionSchema,
  RecordVersionPreconditionSchema,
  Sha256HexSchema,
  TaskCreateParametersSchema,
  TrustedActorContextSchema,
  canonicalizeJson,
  canonicalizeIsoDateTime,
  sameOptionalInstant,
  computeApprovalBindingHash,
  computeCanonicalParameterHash,
  materializeTaskCreateParameters,
  resolveSafeFailureSummary,
  sanitizeFailureSummary,
} from './index.js';

describe('packages/contracts Phase 4 action contracts', () => {
  const validClientId = '10000000-0000-4000-8000-000000000001';
  const validProjectId = '20000000-0000-4000-8000-000000000002';
  const validActorId = '30000000-0000-4000-8000-000000000003';
  const validProposalId = '40000000-0000-4000-8000-000000000004';
  const validEvidenceId = '50000000-0000-4000-8000-000000000005';
  const validOrgId = '60000000-0000-4000-8000-000000000006';

  describe('TaskCreateParametersSchema & Defaults Materialization', () => {
    it('validates a valid task create parameter payload and materializes defaults', () => {
      const input = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Resolve data migration lag',
        description: 'Coordinate with infra team to expand replica capacity.',
      };

      const parsed = TaskCreateParametersSchema.parse(input);
      expect(parsed.title).toBe('Resolve data migration lag');
      expect(parsed.priority).toBe('medium'); // Default priority materialized
      expect(parsed.description).toBe(
        'Coordinate with infra team to expand replica capacity.',
      );

      const materialized = materializeTaskCreateParameters(input);
      expect(materialized.priority).toBe('medium');
    });

    it('validates full parameters including assigneeUserId and dueAt', () => {
      const input = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Conduct executive sync',
        description: 'Briefing follow-up with Acme VP',
        assigneeUserId: validActorId,
        assigneeDisplayName: 'Alice Walker',
        dueAt: '2026-10-18T17:00:00.000Z',
        priority: 'urgent' as const,
      };

      const parsed = TaskCreateParametersSchema.parse(input);
      expect(parsed.priority).toBe('urgent');
      expect(parsed.assigneeUserId).toBe(validActorId);
      expect(parsed.assigneeDisplayName).toBe('Alice Walker');
      expect(parsed.dueAt).toBe('2026-10-18T17:00:00.000Z');
    });

    it('rejects invalid UUIDs or empty title', () => {
      expect(() =>
        TaskCreateParametersSchema.parse({
          clientId: 'not-a-uuid',
          projectId: validProjectId,
          title: 'Valid title',
        }),
      ).toThrow();

      expect(() =>
        TaskCreateParametersSchema.parse({
          clientId: validClientId,
          projectId: validProjectId,
          title: '', // Empty title
        }),
      ).toThrow();
    });

    it('rejects unrecognized extra fields due to strict schema', () => {
      expect(() =>
        TaskCreateParametersSchema.parse({
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Valid title',
          unauthorizedField: 'malicious-data',
        }),
      ).toThrow();
    });

    it('canonicalizes dueAt to UTC ISO-8601 millisecond precision (.000Z) upon materialization', () => {
      const input = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Conduct executive sync',
        dueAt: '2026-10-16T09:00:00Z',
      };

      const materialized = materializeTaskCreateParameters(input);
      expect(materialized.dueAt).toBe('2026-10-16T09:00:00.000Z');

      const hash = computeCanonicalParameterHash(materialized);
      const expectedParams = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Conduct executive sync',
        priority: 'medium',
        dueAt: '2026-10-16T09:00:00.000Z',
      };
      expect(hash).toBe(computeCanonicalParameterHash(expectedParams));
    });
  });

  describe('Datetime Canonicalization & Temporal Comparison', () => {
    it('canonicalizeIsoDateTime converts non-millisecond ISO string to millisecond precision', () => {
      expect(canonicalizeIsoDateTime('2026-10-16T09:00:00Z')).toBe(
        '2026-10-16T09:00:00.000Z',
      );
    });

    it('canonicalizeIsoDateTime preserves already-millisecond ISO string', () => {
      expect(canonicalizeIsoDateTime('2026-10-16T09:00:00.000Z')).toBe(
        '2026-10-16T09:00:00.000Z',
      );
      expect(canonicalizeIsoDateTime('2026-10-16T09:00:00.123Z')).toBe(
        '2026-10-16T09:00:00.123Z',
      );
    });

    it('canonicalizeIsoDateTime converts timezone offsets to UTC ISO-8601', () => {
      expect(canonicalizeIsoDateTime('2026-10-16T05:00:00-04:00')).toBe(
        '2026-10-16T09:00:00.000Z',
      );
    });

    it('canonicalizeIsoDateTime fails closed for invalid or non-finite date strings', () => {
      expect(() => canonicalizeIsoDateTime('invalid-date')).toThrow(
        /Invalid ISO datetime string/,
      );
      expect(() => canonicalizeIsoDateTime('2026-99-99T99:99:99Z')).toThrow(
        /Invalid ISO datetime string/,
      );
    });

    it('sameOptionalInstant returns true when both inputs are absent', () => {
      expect(sameOptionalInstant(undefined, undefined)).toBe(true);
      expect(sameOptionalInstant(null, null)).toBe(true);
      expect(sameOptionalInstant(undefined, null)).toBe(true);
      expect(sameOptionalInstant(null, undefined)).toBe(true);
    });

    it('sameOptionalInstant returns false when one input is absent and one is present', () => {
      expect(sameOptionalInstant(undefined, '2026-10-16T09:00:00.000Z')).toBe(
        false,
      );
      expect(sameOptionalInstant('2026-10-16T09:00:00.000Z', undefined)).toBe(
        false,
      );
      expect(sameOptionalInstant(null, '2026-10-16T09:00:00.000Z')).toBe(false);
      expect(sameOptionalInstant('2026-10-16T09:00:00.000Z', null)).toBe(false);
    });

    it('sameOptionalInstant returns true for equivalent instants with different textual formatting', () => {
      expect(
        sameOptionalInstant('2026-10-16T09:00:00Z', '2026-10-16T09:00:00.000Z'),
      ).toBe(true);
      expect(
        sameOptionalInstant(
          '2026-10-16T05:00:00-04:00',
          '2026-10-16T09:00:00.000Z',
        ),
      ).toBe(true);
    });

    it('sameOptionalInstant returns true for identical formatting', () => {
      expect(
        sameOptionalInstant(
          '2026-10-16T09:00:00.000Z',
          '2026-10-16T09:00:00.000Z',
        ),
      ).toBe(true);
    });

    it('sameOptionalInstant returns false for a 1ms difference', () => {
      expect(
        sameOptionalInstant(
          '2026-10-16T09:00:00.000Z',
          '2026-10-16T09:00:00.001Z',
        ),
      ).toBe(false);
    });

    it('sameOptionalInstant returns false for invalid date strings', () => {
      expect(
        sameOptionalInstant('invalid-date', '2026-10-16T09:00:00.000Z'),
      ).toBe(false);
      expect(
        sameOptionalInstant('2026-10-16T09:00:00.000Z', 'invalid-date'),
      ).toBe(false);
    });
  });

  describe('Canonical parameter hashing & approval binding', () => {
    it('produces identical canonical JSON and hash regardless of key order', () => {
      const paramsA = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Follow-up task',
        priority: 'high',
      };

      const paramsB = {
        title: 'Follow-up task',
        priority: 'high',
        projectId: validProjectId,
        clientId: validClientId,
      };

      const canonicalA = canonicalizeJson(paramsA);
      const canonicalB = canonicalizeJson(paramsB);
      expect(canonicalA).toBe(canonicalB);

      const hashA = computeCanonicalParameterHash(paramsA);
      const hashB = computeCanonicalParameterHash(paramsB);
      expect(hashA).toBe(hashB);
      expect(hashA).toHaveLength(64);
    });

    it('omits undefined fields from serialization to prevent hash drift', () => {
      const paramsA = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Task A',
      };

      const paramsB = {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Task A',
        description: undefined,
      };

      expect(canonicalizeJson(paramsA)).toBe(canonicalizeJson(paramsB));
      expect(computeCanonicalParameterHash(paramsA)).toBe(
        computeCanonicalParameterHash(paramsB),
      );
    });

    it('computes deterministic approvalBindingHash covering tenant, actionType, params, preconditions, expiresAt', () => {
      const bindingPayload = {
        organizationId: validOrgId,
        actionType: 'task.create',
        parameters: {
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Recovery Task',
          priority: 'medium',
        },
        preconditions: [
          {
            entityType: 'project',
            entityId: validProjectId,
            versionField: 'updated_at',
            expectedValue: '2026-10-01T12:00:00.000Z',
          },
        ],
        expiresAt: '2026-10-05T14:00:00.000Z',
      };

      const hash = computeApprovalBindingHash(bindingPayload);
      expect(hash).toHaveLength(64);

      // Reordering fields produces exact same hash
      const reorderedPayload = {
        expiresAt: '2026-10-05T14:00:00.000Z',
        actionType: 'task.create',
        preconditions: bindingPayload.preconditions,
        parameters: bindingPayload.parameters,
        organizationId: validOrgId,
      };
      expect(computeApprovalBindingHash(reorderedPayload)).toBe(hash);
    });

    it('produces identical approvalBindingHash regardless of precondition array order', () => {
      const pre1 = {
        entityType: 'project',
        entityId: validProjectId,
        versionField: 'updated_at',
        expectedValue: '2026-10-01T12:00:00.000Z',
      };
      const pre2 = {
        entityType: 'client',
        entityId: validClientId,
        versionField: 'updated_at',
        expectedValue: '2026-10-02T15:30:00.000Z',
      };

      const payloadOrderA = {
        organizationId: validOrgId,
        actionType: 'task.create',
        parameters: {
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Task',
        },
        preconditions: [pre1, pre2],
        expiresAt: '2026-10-05T14:00:00.000Z',
      };

      const payloadOrderB = {
        organizationId: validOrgId,
        actionType: 'task.create',
        parameters: {
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Task',
        },
        preconditions: [pre2, pre1],
        expiresAt: '2026-10-05T14:00:00.000Z',
      };

      expect(computeApprovalBindingHash(payloadOrderA)).toBe(
        computeApprovalBindingHash(payloadOrderB),
      );
    });
  });

  describe('RecordVersionPreconditionSchema', () => {
    it('validates authoritative updated_at version precondition', () => {
      const precondition = {
        entityType: 'project' as const,
        entityId: validProjectId,
        versionField: 'updated_at' as const,
        expectedValue: '2026-10-01T12:00:00.000Z',
      };

      const parsed = RecordVersionPreconditionSchema.parse(precondition);
      expect(parsed.versionField).toBe('updated_at');
      expect(parsed.entityId).toBe(validProjectId);
    });

    it('rejects unsupported version fields or invalid timestamps', () => {
      expect(() =>
        RecordVersionPreconditionSchema.parse({
          entityType: 'project',
          entityId: validProjectId,
          versionField: 'custom_counter', // Unsupported version counter
          expectedValue: '2026-10-01T12:00:00.000Z',
        }),
      ).toThrow();
    });
  });

  describe('ActionProposalSchema & ModelActionProposalInputSchema', () => {
    it('validates a complete server-owned ActionProposal with justification and approvalBindingHash', () => {
      const params = materializeTaskCreateParameters({
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Mitigate migration delay',
        priority: 'high',
      });
      const paramHash = computeCanonicalParameterHash(params);
      const preconditions = [
        {
          entityType: 'project' as const,
          entityId: validProjectId,
          versionField: 'updated_at' as const,
          expectedValue: '2026-10-01T00:00:00.000Z',
        },
      ];
      const bindingHash = computeApprovalBindingHash({
        organizationId: validOrgId,
        actionType: 'task.create',
        parameters: params,
        preconditions,
        expiresAt: '2026-10-05T13:00:00.000Z',
      });

      const proposal = {
        id: validProposalId,
        organizationId: validOrgId,
        actionType: 'task.create' as const,
        actionClass: 'WRITE' as const,
        parameters: params,
        parameterHash: paramHash,
        approvalBindingHash: bindingHash,
        correlationId: 'req-corr-12345',
        evidence: [
          {
            entityType: 'milestone' as const,
            entityId: validEvidenceId,
            field: 'due_at',
            excerpt: 'Milestone is 2 days overdue',
          },
        ],
        preconditions,
        status: 'PROPOSED' as const,
        justification: 'Milestone overdue requires recovery task creation.',
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: '2026-10-05T13:00:00.000Z',
      };

      const parsed = ActionProposalSchema.parse(proposal);
      expect(parsed.id).toBe(validProposalId);
      expect(parsed.organizationId).toBe(validOrgId);
      expect(parsed.parameterHash).toBe(paramHash);
      expect(parsed.approvalBindingHash).toBe(bindingHash);
      expect(parsed.justification).toBe(
        'Milestone overdue requires recovery task creation.',
      );
      expect(parsed.status).toBe('PROPOSED');
    });

    it('validates untrusted ModelActionProposalInput with citations pointer only', () => {
      const validModelInput = {
        actionType: 'task.create' as const,
        parameters: {
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Remediate missing runbook',
        },
        justification:
          'Commitment overdue warrants immediate remediation task.',
        citations: [
          {
            entityType: 'commitment' as const,
            entityId: validEvidenceId,
            field: 'due_at',
          },
        ],
      };

      const parsed = ModelActionProposalInputSchema.parse(validModelInput);
      expect(parsed.actionType).toBe('task.create');
      expect(parsed.justification).toBe(
        'Commitment overdue warrants immediate remediation task.',
      );

      // Model cannot supply organizationId, status, or excerpts
      expect(() =>
        ModelActionProposalInputSchema.parse({
          ...validModelInput,
          organizationId: validOrgId,
        }),
      ).toThrow();

      expect(() =>
        ModelActionProposalInputSchema.parse({
          ...validModelInput,
          status: 'APPROVED',
        }),
      ).toThrow();

      // Citations cannot be empty
      expect(() =>
        ModelActionProposalInputSchema.parse({
          ...validModelInput,
          citations: [],
        }),
      ).toThrow(/at least one authoritative evidence/);
    });
  });

  describe('TrustedActorContextSchema & Approvals', () => {
    it('validates trusted actor context with valid role and source', () => {
      const actor = {
        organizationId: validOrgId,
        actorId: validActorId,
        role: 'operator' as const,
        source: 'local_demo_adapter' as const,
        isProductionActor: false,
      };

      const parsed = TrustedActorContextSchema.parse(actor);
      expect(parsed.role).toBe('operator');
      expect(parsed.isProductionActor).toBe(false);
    });

    it('validates ApprovalRecord with approvalBindingHash and decisions', () => {
      const approveRecord = {
        id: '70000000-0000-4000-8000-000000000007',
        actionProposalId: validProposalId,
        organizationId: validOrgId,
        actorId: validActorId,
        actorRole: 'operator' as const,
        decision: 'APPROVE' as const,
        decidedAt: '2026-10-05T12:05:00.000Z',
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        validUntil: '2026-10-05T13:00:00.000Z',
        comment: 'Approved after executive review',
      };

      expect(ApprovalDecisionSchema.parse('APPROVE')).toBe('APPROVE');
      expect(ApprovalDecisionSchema.parse('DENY')).toBe('DENY');
      expect(ApprovalRecordSchema.parse(approveRecord).decision).toBe(
        'APPROVE',
      );
      expect(
        ApprovalRecordSchema.parse(approveRecord).approvalBindingHash,
      ).toBe('b'.repeat(64));

      const denyRecord = {
        ...approveRecord,
        decision: 'DENY' as const,
        comment: 'Denied: milestone date already adjusted.',
      };
      expect(ApprovalRecordSchema.parse(denyRecord).decision).toBe('DENY');
    });

    it('validates PolicyDecisionSchema, ActionTypeSchema, and ActionStatusSchema', () => {
      expect(ActionTypeSchema.parse('task.create')).toBe('task.create');
      expect(ActionStatusSchema.parse('PROPOSED')).toBe('PROPOSED');
      expect(ActionStatusSchema.parse('APPROVED')).toBe('APPROVED');

      const policyDecision = {
        decision: 'REQUIRES_APPROVAL' as const,
        actionType: 'task.create',
        actionClass: 'WRITE' as const,
        reason: 'WRITE actions require approval',
      };
      expect(PolicyDecisionSchema.parse(policyDecision)).toEqual(
        policyDecision,
      );
    });

    it('validates ExecutionAuthorization and ExecutionResult', () => {
      const auth = {
        actionProposalId: validProposalId,
        organizationId: validOrgId,
        approvedByActorId: validActorId,
        parameterHash: 'b'.repeat(64),
        approvalBindingHash: 'c'.repeat(64),
        approvedAt: '2026-10-05T12:05:00.000Z',
        validUntil: '2026-10-05T13:00:00.000Z',
      };
      expect(ExecutionAuthorizationSchema.parse(auth).actionProposalId).toBe(
        validProposalId,
      );

      const result = {
        executionId: '80000000-0000-4000-8000-000000000008',
        actionProposalId: validProposalId,
        organizationId: validOrgId,
        status: 'COMPLETED' as const,
        executedAt: '2026-10-05T12:06:00.000Z',
        resultEntityId: '90000000-0000-4000-8000-000000000009',
      };
      expect(ExecutionResultSchema.parse(result).status).toBe('COMPLETED');
    });
  });

  describe('Strict Event-Specific AuditEventSchema', () => {
    it('validates all 8 audit event types with strict allowlisted payload schemas', () => {
      const eventConfigs = [
        {
          eventType: 'ACTION_PROPOSED' as const,
          payload: {
            actionProposalId: validProposalId,
            actionType: 'task.create' as const,
            actionClass: 'WRITE' as const,
            parameterHash: 'a'.repeat(64),
            approvalBindingHash: 'b'.repeat(64),
            justification: 'Recovery task needed',
            clientId: validClientId,
            projectId: validProjectId,
            preconditionCount: 1,
            citationCount: 1,
          },
        },
        {
          eventType: 'APPROVAL_REQUESTED' as const,
          payload: {
            actionProposalId: validProposalId,
            requestedAt: '2026-10-05T12:01:00.000Z',
            expiresAt: '2026-10-05T13:00:00.000Z',
            approvalBindingHash: 'b'.repeat(64),
          },
        },
        {
          eventType: 'ACTION_APPROVED' as const,
          payload: {
            actionProposalId: validProposalId,
            actorId: validActorId,
            actorRole: 'operator' as const,
            decidedAt: '2026-10-05T12:05:00.000Z',
            approvalBindingHash: 'b'.repeat(64),
            comment: 'Approved by lead',
          },
        },
        {
          eventType: 'ACTION_DENIED' as const,
          payload: {
            actionProposalId: validProposalId,
            actorId: validActorId,
            actorRole: 'operator' as const,
            decidedAt: '2026-10-05T12:05:00.000Z',
            reason: 'Denied: not required',
          },
        },
        {
          eventType: 'ACTION_EXPIRED' as const,
          payload: {
            actionProposalId: validProposalId,
            expiredAt: '2026-10-05T13:00:00.000Z',
            previousStatus: 'PENDING_APPROVAL' as const,
          },
        },
        {
          eventType: 'EXECUTION_STARTED' as const,
          payload: {
            actionProposalId: validProposalId,
            executionId: '80000000-0000-4000-8000-000000000008',
            executorPrincipal: 'clientops_trusted_executor' as const,
            startedAt: '2026-10-05T12:06:00.000Z',
            approvalBindingHash: 'b'.repeat(64),
          },
        },
        {
          eventType: 'EXECUTION_COMPLETED' as const,
          payload: {
            actionProposalId: validProposalId,
            executionId: '80000000-0000-4000-8000-000000000008',
            targetEntityType: 'task' as const,
            targetEntityId: '90000000-0000-4000-8000-000000000009',
            completedAt: '2026-10-05T12:06:05.000Z',
            durationMs: 50,
          },
        },
        {
          eventType: 'EXECUTION_FAILED' as const,
          payload: {
            actionProposalId: validProposalId,
            executionId: '80000000-0000-4000-8000-000000000008',
            errorCode: 'PRECONDITION_FAILED',
            failureSummary: 'Project was modified',
            failedAt: '2026-10-05T12:06:05.000Z',
          },
        },
      ];

      for (const config of eventConfigs) {
        expect(AuditEventTypeSchema.parse(config.eventType)).toBe(
          config.eventType,
        );

        const event = {
          id: 'a0000000-0000-4000-8000-00000000000a',
          organizationId: validOrgId,
          actionProposalId: validProposalId,
          eventType: config.eventType,
          actorId: validActorId,
          parameterHash: 'c'.repeat(64),
          approvalBindingHash: 'b'.repeat(64),
          correlationId: 'req-corr-999',
          payload: config.payload,
          occurredAt: '2026-10-05T12:00:00.000Z',
        };

        const parsed = AuditEventSchema.parse(event);
        expect(parsed.eventType).toBe(config.eventType);
      }
    });

    it('rejects arbitrary untyped payloads in audit events', () => {
      const invalidEvent = {
        id: 'a0000000-0000-4000-8000-00000000000a',
        organizationId: validOrgId,
        eventType: 'EXECUTION_COMPLETED' as const,
        payload: {
          arbitraryModelOutput: 'This should fail schema validation',
          rawPrompt: 'You are an agent...',
        },
        occurredAt: '2026-10-05T12:00:00.000Z',
      };

      expect(() => AuditEventSchema.parse(invalidEvent)).toThrow();
    });
  });

  describe('Sha256HexSchema & Hash Storage Hardening', () => {
    it('accepts valid 64-character lowercase hexadecimal hash', () => {
      const validHash =
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      expect(Sha256HexSchema.parse(validHash)).toBe(validHash);
    });

    it('rejects uppercase hexadecimal characters', () => {
      const uppercaseHash =
        'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
      expect(() => Sha256HexSchema.parse(uppercaseHash)).toThrow(
        /64-character lowercase hex/,
      );
    });

    it('rejects non-hexadecimal characters or wrong length', () => {
      expect(() => Sha256HexSchema.parse('zzzz' + 'a'.repeat(60))).toThrow();
      expect(() => Sha256HexSchema.parse('a'.repeat(63))).toThrow();
      expect(() => Sha256HexSchema.parse('a'.repeat(65))).toThrow();
      expect(() => Sha256HexSchema.parse('')).toThrow();
    });
  });

  describe('Grounded Action Proposals (evidence and preconditions)', () => {
    const validParams = materializeTaskCreateParameters({
      clientId: validClientId,
      projectId: validProjectId,
      title: 'Valid Grounded Task',
    });
    const validEvidence = [
      {
        entityType: 'milestone' as const,
        entityId: validEvidenceId,
        field: 'due_at',
        excerpt: 'Milestone is delayed',
      },
    ];
    const validPreconditions = [
      {
        entityType: 'project' as const,
        entityId: validProjectId,
        versionField: 'updated_at' as const,
        expectedValue: '2026-10-01T00:00:00.000Z',
      },
    ];

    it('rejects action proposal with empty evidence array', () => {
      const proposal = {
        id: validProposalId,
        organizationId: validOrgId,
        actionType: 'task.create' as const,
        actionClass: 'WRITE' as const,
        parameters: validParams,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        correlationId: 'req-corr-1',
        evidence: [],
        preconditions: validPreconditions,
        status: 'PROPOSED' as const,
        justification: 'Grounded justification',
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: '2026-10-05T13:00:00.000Z',
      };

      expect(() => ActionProposalSchema.parse(proposal)).toThrow(
        /at least one evidence item/,
      );
    });

    it('rejects action proposal with empty preconditions array', () => {
      const proposal = {
        id: validProposalId,
        organizationId: validOrgId,
        actionType: 'task.create' as const,
        actionClass: 'WRITE' as const,
        parameters: validParams,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        correlationId: 'req-corr-1',
        evidence: validEvidence,
        preconditions: [],
        status: 'PROPOSED' as const,
        justification: 'Grounded justification',
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: '2026-10-05T13:00:00.000Z',
      };

      expect(() => ActionProposalSchema.parse(proposal)).toThrow(
        /at least one precondition/,
      );
    });

    it('rejects task.create proposal missing target project updated_at precondition', () => {
      const otherProjectId = '99999999-0000-4000-8000-000000000009';
      const proposal = {
        id: validProposalId,
        organizationId: validOrgId,
        actionType: 'task.create' as const,
        actionClass: 'WRITE' as const,
        parameters: validParams,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        correlationId: 'req-corr-1',
        evidence: validEvidence,
        preconditions: [
          {
            entityType: 'project' as const,
            entityId: otherProjectId, // wrong project ID
            versionField: 'updated_at' as const,
            expectedValue: '2026-10-01T00:00:00.000Z',
          },
        ],
        status: 'PROPOSED' as const,
        justification: 'Grounded justification',
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: '2026-10-05T13:00:00.000Z',
      };

      expect(() => ActionProposalSchema.parse(proposal)).toThrow(
        /must include an updated_at precondition for target project/,
      );
    });
  });

  describe('ActionExecutionRecordSchema & Executor Principal', () => {
    const validExecutionId = '80000000-0000-4000-8000-000000000008';
    const validApprovalId = '70000000-0000-4000-8000-000000000007';

    it('validates execution record with mandatory actionApprovalId and defaults executorPrincipal', () => {
      const exec = {
        id: validExecutionId,
        organizationId: validOrgId,
        actionProposalId: validProposalId,
        actionApprovalId: validApprovalId,
        status: 'EXECUTING' as const,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        startedAt: '2026-10-05T12:06:00.000Z',
      };

      const parsed = ActionExecutionRecordSchema.parse(exec);
      expect(parsed.executorPrincipal).toBe('clientops_trusted_executor');
      expect(parsed.actionApprovalId).toBe(validApprovalId);
    });

    it('rejects execution record missing actionApprovalId', () => {
      const exec = {
        id: validExecutionId,
        organizationId: validOrgId,
        actionProposalId: validProposalId,
        status: 'EXECUTING' as const,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        startedAt: '2026-10-05T12:06:00.000Z',
      };

      expect(() => ActionExecutionRecordSchema.parse(exec)).toThrow();
    });

    it('rejects execution record with unauthorized executor principal', () => {
      const exec = {
        id: validExecutionId,
        organizationId: validOrgId,
        actionProposalId: validProposalId,
        actionApprovalId: validApprovalId,
        executorPrincipal: 'malicious_principal',
        status: 'EXECUTING' as const,
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        startedAt: '2026-10-05T12:06:00.000Z',
      };

      expect(() => ActionExecutionRecordSchema.parse(exec)).toThrow();
    });
  });

  describe('sanitizeFailureSummary (Error Sanitization)', () => {
    it('returns undefined for null or undefined input', () => {
      expect(sanitizeFailureSummary(null)).toBeUndefined();
      expect(sanitizeFailureSummary(undefined)).toBeUndefined();
    });

    it('strips stack traces from raw Error instances', () => {
      const err = new Error('Database transaction deadlocked');
      err.stack =
        'Error: Database transaction deadlocked\n    at query (/workspaces/clientops-command/db.ts:42:15)\n    at execute (/workspaces/clientops-command/exec.ts:10:5)';
      const sanitized = sanitizeFailureSummary(err);
      expect(sanitized).toBe('Database transaction deadlocked');
      expect(sanitized).not.toContain('at query');
      expect(sanitized).not.toContain('/workspaces/');
    });

    it('redacts tokens, bearer auth, and secrets', () => {
      const raw =
        'Request failed: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token password=supersecret password123';
      const sanitized = sanitizeFailureSummary(raw);
      expect(sanitized).toContain('[REDACTED_TOKEN]');
      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).not.toContain('supersecret');
      expect(sanitized).not.toContain('eyJhbG');
    });

    it('redacts database connection strings and filesystem paths', () => {
      const raw =
        'Failed to connect to postgresql://postgres:secretpassword@db.example.com:5432/clientops while loading /home/codespace/app/config.json';
      const sanitized = sanitizeFailureSummary(raw);
      expect(sanitized).toContain('postgres://[REDACTED]@host');
      expect(sanitized).toContain('[REDACTED_PATH]');
      expect(sanitized).not.toContain('secretpassword');
      expect(sanitized).not.toContain('/home/codespace/');
    });

    it('bounds failure summary length to at most 500 characters', () => {
      const longMessage = 'A'.repeat(600);
      const sanitized = sanitizeFailureSummary(longMessage);
      expect(sanitized).toBeDefined();
      expect(sanitized!.length).toBeLessThanOrEqual(500);
      expect(sanitized!.endsWith('...')).toBe(true);
    });
  });

  describe('resolveSafeFailureSummary & ExecutionErrorCode', () => {
    it('maps known error codes to predefined safe failure summaries', () => {
      expect(resolveSafeFailureSummary('PRECONDITION_FAILED')).toEqual({
        errorCode: 'PRECONDITION_FAILED',
        failureSummary:
          'A record version precondition was not met at execution time.',
      });
      expect(resolveSafeFailureSummary('APPROVAL_EXPIRED')).toEqual({
        errorCode: 'APPROVAL_EXPIRED',
        failureSummary: 'The action approval expired prior to execution.',
      });
      expect(resolveSafeFailureSummary('APPROVAL_BINDING_MISMATCH')).toEqual({
        errorCode: 'APPROVAL_BINDING_MISMATCH',
        failureSummary: 'Approval authorization binding hash mismatch.',
      });
      expect(resolveSafeFailureSummary('TENANT_MISMATCH')).toEqual({
        errorCode: 'TENANT_MISMATCH',
        failureSummary: 'Tenant context does not match the approved proposal.',
      });
      expect(resolveSafeFailureSummary('TASK_CREATION_FAILED')).toEqual({
        errorCode: 'TASK_CREATION_FAILED',
        failureSummary:
          'Task creation business validation or database insertion failed.',
      });
      expect(resolveSafeFailureSummary('IDEMPOTENCY_CONFLICT')).toEqual({
        errorCode: 'IDEMPOTENCY_CONFLICT',
        failureSummary: 'An execution record already exists for this proposal.',
      });
      expect(resolveSafeFailureSummary('INTERNAL_EXECUTION_ERROR')).toEqual({
        errorCode: 'INTERNAL_EXECUTION_ERROR',
        failureSummary:
          'Task creation failed due to an internal execution error.',
      });
    });

    it('defaults unknown error code to INTERNAL_EXECUTION_ERROR with safe summary', () => {
      expect(resolveSafeFailureSummary('UNKNOWN_ERR')).toEqual({
        errorCode: 'INTERNAL_EXECUTION_ERROR',
        failureSummary:
          'Task creation failed due to an internal execution error.',
      });
      expect(resolveSafeFailureSummary(null)).toEqual({
        errorCode: 'INTERNAL_EXECUTION_ERROR',
        failureSummary:
          'Task creation failed due to an internal execution error.',
      });
    });

    it('proves raw exception/provider/SQL text never leaks into durable output', () => {
      const messages = [
        'AWS error: AccessKeyId AKIAIOSFODNN7EXAMPLE Secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'Connection refused postgres://admin:supersecret@db.internal:5432/prod',
        'ENOENT /home/codespace/app/server/secrets.json',
        'syntax error at or near "SELECT" in internal driver query',
        new Error('Fatal driver crash with stack at query()'),
      ];

      for (const raw of messages) {
        const res = resolveSafeFailureSummary('CUSTOM_UNKNOWN', raw);
        expect(res.errorCode).toBe('INTERNAL_EXECUTION_ERROR');
        expect(res.failureSummary).toBe(
          'Task creation failed due to an internal execution error.',
        );
        expect(res.failureSummary).not.toContain('AKIA');
        expect(res.failureSummary).not.toContain('supersecret');
        expect(res.failureSummary).not.toContain('/home/');
        expect(res.failureSummary).not.toContain('SELECT');
      }
    });
  });

  describe('CreateActionProposalInputSchema & Audit Discriminated Union', () => {
    it('enforces status PROPOSED on CreateActionProposalInputSchema', () => {
      const validBase = {
        id: validProposalId,
        organizationId: validOrgId,
        actionType: 'task.create' as const,
        actionClass: 'WRITE' as const,
        parameters: {
          clientId: validClientId,
          projectId: validProjectId,
          title: 'Remediate missing runbook',
        },
        parameterHash: 'a'.repeat(64),
        approvalBindingHash: 'b'.repeat(64),
        correlationId: 'req-123',
        evidence: [
          {
            entityType: 'project' as const,
            entityId: validProjectId,
            excerpt: 'excerpt',
          },
        ],
        preconditions: [
          {
            entityType: 'project' as const,
            entityId: validProjectId,
            versionField: 'updated_at' as const,
            expectedValue: '2026-10-05T12:00:00.000Z',
          },
        ],
        justification: 'justification',
        createdAt: '2026-10-05T12:00:00.000Z',
        expiresAt: '2026-10-05T13:00:00.000Z',
      };

      // Valid: status 'PROPOSED' or defaulted
      expect(
        CreateActionProposalInputSchema.parse({
          ...validBase,
          status: 'PROPOSED',
        }).status,
      ).toBe('PROPOSED');
      expect(CreateActionProposalInputSchema.parse(validBase).status).toBe(
        'PROPOSED',
      );

      // Invalid: status 'APPROVED', 'COMPLETED', etc.
      for (const illegalStatus of [
        'PENDING_APPROVAL',
        'APPROVED',
        'DENIED',
        'EXPIRED',
        'EXECUTING',
        'COMPLETED',
        'FAILED',
      ]) {
        expect(() =>
          CreateActionProposalInputSchema.parse({
            ...validBase,
            status: illegalStatus,
          }),
        ).toThrow();
      }
    });

    it('rejects viewer role in ActionApprovedPayloadSchema and ActionDeniedPayloadSchema', () => {
      const approvedPayload = {
        actionProposalId: validProposalId,
        actorId: randomUUID(),
        actorRole: 'viewer',
        decidedAt: '2026-10-05T12:05:00.000Z',
        approvalBindingHash: 'b'.repeat(64),
      };
      expect(() =>
        ActionApprovedPayloadSchema.parse(approvedPayload),
      ).toThrow();

      const deniedPayload = {
        actionProposalId: validProposalId,
        actorId: randomUUID(),
        actorRole: 'viewer',
        decidedAt: '2026-10-05T12:05:00.000Z',
        reason: 'Reason',
      };
      expect(() => ActionDeniedPayloadSchema.parse(deniedPayload)).toThrow();
    });

    it('rejects mismatched eventType and payload in AuditEventSchema', () => {
      const executionFailedPayload = {
        actionProposalId: validProposalId,
        executionId: randomUUID(),
        errorCode: 'PRECONDITION_FAILED',
        failureSummary: 'Precondition mismatch',
        failedAt: '2026-10-05T12:10:00.000Z',
      };

      // Mismatched: eventType ACTION_APPROVED with ExecutionFailedPayload
      const mismatchedEvent = {
        id: randomUUID(),
        organizationId: validOrgId,
        eventType: 'ACTION_APPROVED',
        payload: executionFailedPayload,
        occurredAt: '2026-10-05T12:10:00.000Z',
      };

      expect(() => AuditEventSchema.parse(mismatchedEvent)).toThrow();
    });
  });
});
