import { describe, expect, it } from 'vitest';
import {
  CLIENTOPS_TOOL_DEFINITIONS,
  computeApprovalBindingHash,
  computeCanonicalParameterHash,
  type ActionProposal,
  type ApprovalRecord,
  type ExecutionResult,
  type TaskCreateParameters,
  type TrustedActorContext,
} from '@clientops/contracts';
import { createTenantContext, DEMO_ORGANIZATION_ID } from '@clientops/domain';
import {
  assertAuthorizedApproverRole,
  createLocalDemoActorContext,
  LOCAL_DEMO_OPERATOR_ACTOR_ID,
} from './actor-adapter.js';
import {
  type AuthoritativeEvidenceResolver,
  ProposalEvidenceResolutionError,
  resolveProposalEvidence,
} from './evidence-resolver.js';
import { validateExecutionPrecheck } from './execution-gate.js';
import {
  classifyActionClass,
  evaluatePolicy,
  isKnownActionType,
} from './policy.js';
import {
  ALLOWED_STATE_TRANSITIONS,
  assertValidTransition,
  canTransition,
  IllegalStateTransitionError,
} from './state-machine.js';

describe('Phase 4 Policy & Action Lifecycle Suite', () => {
  const orgId = DEMO_ORGANIZATION_ID;
  const otherOrgId = '20000000-0000-4000-8000-000000000002';
  const tenantContext = createTenantContext(orgId);

  const validParams: TaskCreateParameters = {
    clientId: '30000000-0000-4000-8000-000000000003',
    projectId: '40000000-0000-4000-8000-000000000004',
    title: 'Acme recovery task',
    priority: 'high',
  };
  const validHash = computeCanonicalParameterHash(validParams);
  const expiresAt = '2026-10-05T14:00:00.000Z';
  const validBindingHash = computeApprovalBindingHash({
    organizationId: orgId,
    actionType: 'task.create',
    parameters: validParams,
    preconditions: [],
    expiresAt,
  });

  const baseProposal: ActionProposal = {
    id: '50000000-0000-4000-8000-000000000005',
    organizationId: orgId,
    actionType: 'task.create',
    actionClass: 'WRITE',
    parameters: validParams,
    parameterHash: validHash,
    approvalBindingHash: validBindingHash,
    correlationId: 'corr-001',
    evidence: [
      {
        entityType: 'milestone',
        entityId: '60000000-0000-4000-8000-000000000006',
        field: 'due_at',
      },
    ],
    preconditions: [],
    status: 'APPROVED',
    justification: 'Milestone overdue requires recovery task.',
    createdAt: '2026-10-05T12:00:00.000Z',
    expiresAt,
  };

  const baseApproval: ApprovalRecord = {
    id: '70000000-0000-4000-8000-000000000007',
    actionProposalId: baseProposal.id,
    organizationId: orgId,
    actorId: LOCAL_DEMO_OPERATOR_ACTOR_ID,
    actorRole: 'operator',
    decision: 'APPROVE',
    decidedAt: '2026-10-05T12:05:00.000Z',
    parameterHash: validHash,
    approvalBindingHash: validBindingHash,
    validUntil: expiresAt,
    comment: 'Approved for recovery execution',
  };

  const baseActor: TrustedActorContext = {
    organizationId: orgId,
    actorId: LOCAL_DEMO_OPERATOR_ACTOR_ID,
    role: 'operator',
    source: 'local_demo_adapter',
    isProductionActor: false,
  };

  const validEvaluationTime = new Date('2026-10-05T12:30:00.000Z');

  // ============================================================================
  // 1. Policy Classification & Provider-Independent Evaluation
  // ============================================================================

  describe('Policy Classification & Evaluation', () => {
    it('automatically allows READ and ANALYZE tools without mutation', () => {
      const readTools = [
        'system.get_status',
        'account.get_context',
        'activity.get_recent',
        'commitment.list_open',
      ];
      for (const tool of readTools) {
        expect(classifyActionClass(tool)).toBe('READ');
        const policy = evaluatePolicy(tool);
        expect(policy.decision).toBe('AUTOMATIC_ALLOW');
        expect(policy.actionClass).toBe('READ');
      }

      const analyzeTools = [
        'project.assess_delivery_health',
        'meeting.prepare_brief',
      ];
      for (const tool of analyzeTools) {
        expect(classifyActionClass(tool)).toBe('ANALYZE');
        const policy = evaluatePolicy(tool);
        expect(policy.decision).toBe('AUTOMATIC_ALLOW');
        expect(policy.actionClass).toBe('ANALYZE');
      }
    });

    it('automatically allows DRAFT actions as internal text with zero side effects', () => {
      expect(classifyActionClass('client_update.draft')).toBe('DRAFT');
      const policy = evaluatePolicy('client_update.draft');
      expect(policy.decision).toBe('AUTOMATIC_ALLOW');
      expect(policy.actionClass).toBe('DRAFT');
    });

    it('strictly requires human approval for task.create WRITE action', () => {
      expect(classifyActionClass('task.create')).toBe('WRITE');
      const policy = evaluatePolicy('task.create');
      expect(policy.decision).toBe('REQUIRES_APPROVAL');
      expect(policy.actionClass).toBe('WRITE');
    });

    it('denies EXTERNAL actions in v1', () => {
      const externalActions = [
        'external.send_email',
        'external.slack_post',
        'external.webhook',
      ];
      for (const action of externalActions) {
        expect(classifyActionClass(action)).toBe('EXTERNAL');
        const policy = evaluatePolicy(action);
        expect(policy.decision).toBe('DENIED');
      }
    });

    it('denies DESTRUCTIVE actions in v1', () => {
      const destructiveActions = ['data.delete', 'data.drop', 'data.reset'];
      for (const action of destructiveActions) {
        expect(classifyActionClass(action)).toBe('DESTRUCTIVE');
        const policy = evaluatePolicy(action);
        expect(policy.decision).toBe('DENIED');
      }
    });

    it('fails closed on unknown actions by deterministically evaluating to DENIED', () => {
      expect(isKnownActionType('unknown.custom_operation')).toBe(false);
      expect(classifyActionClass('unknown.custom_operation')).toBe('EXTERNAL');
      const policy = evaluatePolicy('unknown.custom_operation');
      expect(policy.decision).toBe('DENIED');
      expect(policy.actionClass).not.toBe('WRITE');
      expect(policy.decision).not.toBe('REQUIRES_APPROVAL');
    });
  });

  // ============================================================================
  // 2. Action Lifecycle State Machine
  // ============================================================================

  describe('Action Lifecycle State Machine', () => {
    it('permits all valid lifecycle paths', () => {
      // PROPOSED -> PENDING_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED
      expect(canTransition('PROPOSED', 'PENDING_APPROVAL')).toBe(true);
      expect(canTransition('PENDING_APPROVAL', 'APPROVED')).toBe(true);
      expect(canTransition('APPROVED', 'EXECUTING')).toBe(true);
      expect(canTransition('EXECUTING', 'COMPLETED')).toBe(true);

      // Failure path: EXECUTING -> FAILED
      expect(canTransition('EXECUTING', 'FAILED')).toBe(true);

      // Rejection paths: PENDING_APPROVAL -> DENIED (PROPOSED -> DENIED is forbidden)
      expect(canTransition('PENDING_APPROVAL', 'DENIED')).toBe(true);
      expect(canTransition('PROPOSED', 'DENIED')).toBe(false);

      // Expiry paths: PROPOSED -> EXPIRED, PENDING_APPROVAL -> EXPIRED, APPROVED -> EXPIRED
      expect(canTransition('PROPOSED', 'EXPIRED')).toBe(true);
      expect(canTransition('PENDING_APPROVAL', 'EXPIRED')).toBe(true);
      expect(canTransition('APPROVED', 'EXPIRED')).toBe(true);
    });

    it('strictly forbids illegal transitions and fails closed', () => {
      // PROPOSED -> DENIED: INVALID (human denial requires PENDING_APPROVAL)
      expect(canTransition('PROPOSED', 'DENIED')).toBe(false);
      expect(() => assertValidTransition('PROPOSED', 'DENIED')).toThrow(
        IllegalStateTransitionError,
      );

      // DENIED -> APPROVED: INVALID
      expect(canTransition('DENIED', 'APPROVED')).toBe(false);
      expect(() => assertValidTransition('DENIED', 'APPROVED')).toThrow(
        IllegalStateTransitionError,
      );

      // EXPIRED -> APPROVED: INVALID
      expect(canTransition('EXPIRED', 'APPROVED')).toBe(false);
      expect(() => assertValidTransition('EXPIRED', 'APPROVED')).toThrow(
        IllegalStateTransitionError,
      );

      // COMPLETED -> EXECUTING: INVALID
      expect(canTransition('COMPLETED', 'EXECUTING')).toBe(false);
      expect(() => assertValidTransition('COMPLETED', 'EXECUTING')).toThrow(
        IllegalStateTransitionError,
      );

      // COMPLETED -> COMPLETED again: INVALID
      expect(canTransition('COMPLETED', 'COMPLETED')).toBe(false);
      expect(() => assertValidTransition('COMPLETED', 'COMPLETED')).toThrow(
        IllegalStateTransitionError,
      );

      // FAILED -> EXECUTING: INVALID
      expect(canTransition('FAILED', 'EXECUTING')).toBe(false);
      expect(() => assertValidTransition('FAILED', 'EXECUTING')).toThrow(
        IllegalStateTransitionError,
      );

      // Terminal states have zero allowed transitions
      expect(ALLOWED_STATE_TRANSITIONS.DENIED).toHaveLength(0);
      expect(ALLOWED_STATE_TRANSITIONS.EXPIRED).toHaveLength(0);
      expect(ALLOWED_STATE_TRANSITIONS.COMPLETED).toHaveLength(0);
      expect(ALLOWED_STATE_TRANSITIONS.FAILED).toHaveLength(0);
    });
  });

  // ============================================================================
  // 3. The 12 Frozen Security Gates (Zero-Violation Proofs)
  // ============================================================================

  describe('The 12 Frozen Security Gates', () => {
    it('Gate 1: write without approval = 0 (fails closed if approval missing or status not APPROVED)', () => {
      // Missing approval record
      const withoutApproval = validateExecutionPrecheck({
        proposal: baseProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: null,
        currentTimestamp: validEvaluationTime,
      });
      expect(withoutApproval.allowed).toBe(false);
      expect(withoutApproval.gateViolations).toContain(
        'MISSING_APPROVAL_RECORD',
      );

      // Status PROPOSED rather than APPROVED
      const proposedStatus = validateExecutionPrecheck({
        proposal: { ...baseProposal, status: 'PROPOSED' },
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(proposedStatus.allowed).toBe(false);
      expect(proposedStatus.gateViolations).toContain(
        'INVALID_PROPOSAL_STATUS',
      );
    });

    it('Gate 2: model approval capability = 0 (model cannot approve or transition state)', () => {
      // Model lacks trusted actor context; attempting approval without trusted actor fails
      const modelUntrustedActor: TrustedActorContext = {
        organizationId: orgId,
        actorId: '99999999-9999-4000-8000-999999999999',
        role: 'viewer', // Untrusted/model caller
        source: 'local_demo_adapter',
        isProductionActor: false,
      };

      const result = validateExecutionPrecheck({
        proposal: baseProposal,
        tenantContext,
        actorContext: modelUntrustedActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('UNAUTHORIZED_ACTOR_ROLE');
    });

    it('Gate 3: approval MCP tools = 0 (no approval tools exposed over MCP)', () => {
      const toolNames = Object.values(CLIENTOPS_TOOL_DEFINITIONS).map(
        (t) => t.name,
      );
      expect(toolNames).not.toContain('action.approve');
      expect(toolNames).not.toContain('action.deny');
      expect(toolNames).not.toContain('proposal.approve');
      expect(toolNames).not.toContain('human.approve');
      expect(
        toolNames.some((name) => name.toLowerCase().includes('approve')),
      ).toBe(false);
    });

    it('Gate 4: tampered parameters after approval = 0 (hash mismatch fails closed)', () => {
      // Tampering with parameters after approval was recorded
      const tamperedProposal: ActionProposal = {
        ...baseProposal,
        parameters: {
          ...validParams,
          title: 'Tampered title injected after approval',
        },
      };

      const result = validateExecutionPrecheck({
        proposal: tamperedProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('PARAMETER_TAMPERING_DETECTED');
    });

    it('Gate 5: expired approval execution = 0 (expired timestamp fails closed)', () => {
      const expiredTimestamp = new Date('2026-10-05T15:00:00.000Z'); // After 14:00 expiry

      const result = validateExecutionPrecheck({
        proposal: baseProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: expiredTimestamp,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('EXPIRED_PROPOSAL_EXECUTION');
      expect(result.gateViolations).toContain('EXPIRED_APPROVAL_EXECUTION');
    });

    it('Gate 6: denied approval execution = 0 (denied approval fails closed)', () => {
      const deniedApproval: ApprovalRecord = {
        ...baseApproval,
        decision: 'DENY',
        comment: 'Denied by operations lead',
      };

      const result = validateExecutionPrecheck({
        proposal: { ...baseProposal, status: 'DENIED' },
        tenantContext,
        actorContext: baseActor,
        approvalRecord: deniedApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('DENIED_APPROVAL_EXECUTION');
    });

    it('Gate 7: cross-tenant execution = 0 (tenant mismatch fails closed)', () => {
      // Proposal belongs to another organization
      const crossTenantProposal: ActionProposal = {
        ...baseProposal,
        organizationId: otherOrgId,
      };

      const result = validateExecutionPrecheck({
        proposal: crossTenantProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('CROSS_TENANT_VIOLATION');
    });

    it('Gate 8: duplicate task creation = 0 (idempotency prevents duplicate execution)', () => {
      const existingExecution: ExecutionResult = {
        executionId: '88888888-8888-4000-8000-888888888888',
        actionProposalId: baseProposal.id,
        organizationId: orgId,
        status: 'COMPLETED',
        executedAt: '2026-10-05T12:10:00.000Z',
        resultEntityId: '99999999-9999-4000-8000-999999999999',
      };

      const result = validateExecutionPrecheck({
        proposal: baseProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
        existingExecution,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('DUPLICATE_EXECUTION_ATTEMPT');
    });

    it('Gate 9: EXTERNAL execution = 0 (external actions denied)', () => {
      const externalProposal: ActionProposal = {
        ...baseProposal,
        actionType: 'task.create',
        actionClass: 'EXTERNAL',
      };

      const result = validateExecutionPrecheck({
        proposal: externalProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('EXTERNAL_EXECUTION_PROHIBITED');
    });

    it('Gate 10: DESTRUCTIVE execution = 0 (destructive actions denied)', () => {
      const destructiveProposal: ActionProposal = {
        ...baseProposal,
        actionType: 'task.create',
        actionClass: 'DESTRUCTIVE',
      };

      const result = validateExecutionPrecheck({
        proposal: destructiveProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain(
        'DESTRUCTIVE_EXECUTION_PROHIBITED',
      );
    });

    it('Gate 11: audit UPDATE/DELETE = 0 (audit modification operations are classified as DESTRUCTIVE and denied)', () => {
      expect(classifyActionClass('audit.update')).toBe('DESTRUCTIVE');
      expect(classifyActionClass('audit.delete')).toBe('DESTRUCTIVE');

      const updatePolicy = evaluatePolicy('audit.update');
      expect(updatePolicy.decision).toBe('DENIED');
      expect(updatePolicy.actionClass).toBe('DESTRUCTIVE');

      const deletePolicy = evaluatePolicy('audit.delete');
      expect(deletePolicy.decision).toBe('DENIED');
      expect(deletePolicy.actionClass).toBe('DESTRUCTIVE');
    });

    it('Gate 12: untrusted actor approval = 0 (viewer role or invalid context rejected)', () => {
      const viewerActor: TrustedActorContext = {
        ...baseActor,
        role: 'viewer',
      };

      expect(() => assertAuthorizedApproverRole(viewerActor)).toThrow(
        /not authorized to approve actions/,
      );

      const result = validateExecutionPrecheck({
        proposal: baseProposal,
        tenantContext,
        actorContext: viewerActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('UNAUTHORIZED_ACTOR_ROLE');
    });

    it('Gate 4b: approvalBindingHash drift fails closed with APPROVAL_BINDING_MISMATCH', () => {
      // Tampering with preconditions or timestamps changes the binding hash
      const tamperedProposal: ActionProposal = {
        ...baseProposal,
        approvalBindingHash: 'c'.repeat(64), // Injected mismatch
      };

      const result = validateExecutionPrecheck({
        proposal: tamperedProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: baseApproval,
        currentTimestamp: validEvaluationTime,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateViolations).toContain('APPROVAL_BINDING_MISMATCH');
    });

    it('Gate 4c: record-version updated_at preconditions prevent TOCTOU execution drift', () => {
      const projectId = validParams.projectId;
      const originalUpdatedAt = '2026-10-05T11:00:00.000Z';
      const mutatedUpdatedAt = '2026-10-05T12:20:00.000Z';

      const preconditionProposal: ActionProposal = {
        ...baseProposal,
        preconditions: [
          {
            entityType: 'project',
            entityId: projectId,
            versionField: 'updated_at',
            expectedValue: originalUpdatedAt,
          },
        ],
      };
      // Recompute valid hashes with the precondition
      const preconditionBindingHash = computeApprovalBindingHash({
        organizationId: orgId,
        actionType: 'task.create',
        parameters: validParams,
        preconditions: preconditionProposal.preconditions,
        expiresAt,
      });
      const validPreconditionProposal: ActionProposal = {
        ...preconditionProposal,
        approvalBindingHash: preconditionBindingHash,
      };
      const validPreconditionApproval: ApprovalRecord = {
        ...baseApproval,
        approvalBindingHash: preconditionBindingHash,
      };

      // 1. Matches actual updated_at -> passes
      const passing = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
        actualRecordVersions: new Map([
          [`project:${projectId}`, originalUpdatedAt],
        ]),
      });
      expect(passing.allowed).toBe(true);

      // 1b. Execution precheck without actorContext succeeds relying on durable approval record (Requirement 5)
      const passingWithoutActor = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
        actualRecordVersions: new Map([
          [`project:${projectId}`, originalUpdatedAt],
        ]),
      });
      expect(passingWithoutActor.allowed).toBe(true);

      // 1c. Approval record with unauthorized actorRole ('viewer') fails closed (Requirement 5)
      const viewerApproval: ApprovalRecord = {
        ...validPreconditionApproval,
        actorRole: 'viewer' as unknown as 'admin',
      };
      const failingViewerApproval = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        approvalRecord: viewerApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
        actualRecordVersions: new Map([
          [`project:${projectId}`, originalUpdatedAt],
        ]),
      });
      expect(failingViewerApproval.allowed).toBe(false);
      expect(failingViewerApproval.gateViolations).toContain(
        'UNAUTHORIZED_ACTOR_ROLE',
      );

      // 2. Mismatch on updated_at (concurrent modification) -> fails closed
      const failing = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
        actualRecordVersions: new Map([
          [`project:${projectId}`, mutatedUpdatedAt],
        ]),
      });
      expect(failing.allowed).toBe(false);
      expect(failing.gateViolations).toContain('TOCTOU_PRECONDITION_FAILED');

      // 3. Entity missing in backing store -> fails closed
      const missing = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
        actualRecordVersions: new Map(),
      });
      expect(missing.allowed).toBe(false);
      expect(missing.gateViolations).toContain('TOCTOU_PRECONDITION_FAILED');

      // 4. Preconditions present but actualRecordVersions omitted/undefined -> fails closed (Requirement 6)
      const omittedVersions = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: true,
      });
      expect(omittedVersions.allowed).toBe(false);
      expect(omittedVersions.gateViolations).toContain(
        'TOCTOU_PRECONDITION_FAILED',
      );

      // 5. Target project does not exist / is not active -> fails closed (Requirement 6)
      const inactiveProject = validateExecutionPrecheck({
        proposal: validPreconditionProposal,
        tenantContext,
        actorContext: baseActor,
        approvalRecord: validPreconditionApproval,
        currentTimestamp: validEvaluationTime,
        projectExistsAndActive: false,
        actualRecordVersions: new Map([
          [`project:${projectId}`, originalUpdatedAt],
        ]),
      });
      expect(inactiveProject.allowed).toBe(false);
      expect(inactiveProject.gateViolations).toContain(
        'TOCTOU_PRECONDITION_FAILED',
      );
    });
  });

  // ============================================================================
  // 4. Local Demo Actor Adapter & Strict Environment Guard
  // ============================================================================

  describe('LocalDemoActorAdapter Strict Environment Guard', () => {
    it('creates a valid test/demo actor in test runner', () => {
      const actor = createLocalDemoActorContext(tenantContext);
      expect(actor.organizationId).toBe(orgId);
      expect(actor.role).toBe('operator');
      expect(actor.isProductionActor).toBe(false);
      expect(actor.source).toBe('local_demo_adapter');
    });

    it('permits in development environment ONLY when CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalOptIn = process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
      try {
        process.env.NODE_ENV = 'development';
        process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = 'true';
        const actor = createLocalDemoActorContext(tenantContext);
        expect(actor.role).toBe('operator');

        // Without opt-in flag in development -> fails closed
        delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
        expect(() => createLocalDemoActorContext(tenantContext)).toThrow(
          /Security boundary violation: LocalDemoActorAdapter is prohibited in environment 'development'/,
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalOptIn !== undefined) {
          process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = originalOptIn;
        } else {
          delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
        }
      }
    });

    it('fails closed and throws across production, staging, preview, and undefined environments', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalOptIn = process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
      process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = 'true';

      const disallowedEnvs = ['production', 'staging', 'preview', undefined];
      try {
        for (const env of disallowedEnvs) {
          if (env === undefined) {
            delete process.env.NODE_ENV;
          } else {
            process.env.NODE_ENV = env;
          }
          expect(() => createLocalDemoActorContext(tenantContext)).toThrow(
            /Security boundary violation: LocalDemoActorAdapter is prohibited in environment/,
          );
        }
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalOptIn !== undefined) {
          process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = originalOptIn;
        } else {
          delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
        }
      }
    });
  });

  // ============================================================================
  // 5. Proposal Evidence Resolution
  // ============================================================================

  describe('resolveProposalEvidence', () => {
    const validEvidenceRef = {
      entityType: 'project' as const,
      entityId: validParams.projectId,
      field: 'delivery_health',
      excerpt: 'Project delivery health is at_risk due to milestone delay',
    };

    const mockRegistry: AuthoritativeEvidenceResolver = {
      resolveCitation(citation) {
        if (
          citation.entityType === validEvidenceRef.entityType &&
          citation.entityId === validEvidenceRef.entityId &&
          (!citation.field || citation.field === validEvidenceRef.field)
        ) {
          return { success: true, resolved: validEvidenceRef };
        }
        if (citation.entityId === '00000000-0000-0000-0000-000000000000') {
          return { success: false, error: 'Unknown entity ID' };
        }
        if (citation.field === 'wrong_field') {
          return { success: false, error: 'Field mismatch' };
        }
        return { success: false, error: 'Ambiguous or fabricated citation' };
      },
    };

    it('resolves valid citation pointers into canonical server-hydrated EvidenceRef records', () => {
      const citations = [
        {
          entityType: 'project' as const,
          entityId: validParams.projectId,
          field: 'delivery_health',
        },
      ];

      const hydrated = resolveProposalEvidence(citations, mockRegistry);
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0]).toEqual(validEvidenceRef);
    });

    it('rejects unknown or fabricated citations failing closed', () => {
      const fabricatedCitations = [
        {
          entityType: 'project' as const,
          entityId: '00000000-0000-0000-0000-000000000000',
        },
      ];

      expect(() =>
        resolveProposalEvidence(fabricatedCitations, mockRegistry),
      ).toThrow(ProposalEvidenceResolutionError);
    });

    it('rejects wrong-field or ambiguous citations failing closed', () => {
      const wrongFieldCitations = [
        {
          entityType: 'project' as const,
          entityId: validParams.projectId,
          field: 'wrong_field',
        },
      ];

      expect(() =>
        resolveProposalEvidence(wrongFieldCitations, mockRegistry),
      ).toThrow(ProposalEvidenceResolutionError);
    });

    it('rejects empty citation arrays', () => {
      expect(() => resolveProposalEvidence([], mockRegistry)).toThrow(
        /at least one citation is required/,
      );
    });
  });
});
