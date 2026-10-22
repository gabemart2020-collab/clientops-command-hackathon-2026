import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DEMO_ORGANIZATION_ID,
  SECOND_TEST_ORGANIZATION_ID,
  createTenantContext,
  FixedClock,
  type TenantContext,
  type DbClient,
} from '@clientops/domain';
import {
  MockActionProposalRepository,
  MockActionApprovalRepository,
  MockActionExecutionRepository,
  MockControlledTaskMutationRepository,
  MockAuditEventRepository,
  createMockDomainData,
} from './test-helpers.js';
import type {
  ActionStatus,
  ActionProposal,
  ApprovalRecord,
  TaskCreateParameters,
} from '@clientops/contracts';
import {
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
  materializeTaskCreateParameters,
  sameOptionalInstant,
} from '@clientops/contracts';
import {
  executeApprovedAction,
  PreconditionFailedError,
  ProposalNotFoundError,
  UnauthorizedApproverError,
  ProposalTamperedError,
  ConflictError,
  InvalidProposalStatusError,
} from './index.js';
import type { TransactionRunner } from './proposal-service.js';

describe('Phase 4.3 Controlled Execution Service (executeApprovedAction)', () => {
  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
  const fixedClock = new FixedClock('2026-10-15T12:00:00.000Z');

  const validClientId = 'c0000000-0000-4000-8000-000000000001';
  const validProjectId = 'a0000000-0000-4000-8000-000000000001';
  const operatorActorId = '10000000-0000-4000-8000-000000000011'; // Alice Walker, operator

  async function setupApprovedProposal(overrides?: {
    proposalStatus?: ActionStatus;
    approvalDecision?: 'APPROVE' | 'DENY';
    proposalExpiresAt?: string;
    approvalValidUntil?: string;
    paramHashMismatch?: boolean;
    bindingHashMismatch?: boolean;
    assigneeDisplayNameWithoutId?: boolean;
    invalidAssigneeUserId?: boolean;
    invalidMilestoneId?: boolean;
    projectUpdatedAt?: string;
    clientId?: string;
    projectId?: string;
    tenantOrgId?: string;
    dueAt?: string | null;
    customParameters?: TaskCreateParameters;
  }) {
    const proposalRepo = new MockActionProposalRepository();
    const approvalRepo = new MockActionApprovalRepository();
    const executionRepo = new MockActionExecutionRepository();
    const taskMutationRepo = new MockControlledTaskMutationRepository();
    const auditRepo = new MockAuditEventRepository();
    const domainData = createMockDomainData();

    const proposalId = randomUUID();
    const orgId = overrides?.tenantOrgId ?? tenant.organizationId;

    let assigneeUserId: string | undefined = operatorActorId;
    let assigneeDisplayName: string | undefined = 'Alice Walker';

    if (overrides?.assigneeDisplayNameWithoutId) {
      assigneeUserId = undefined;
      assigneeDisplayName = 'Alice Walker';
    } else if (overrides?.invalidAssigneeUserId) {
      assigneeUserId = randomUUID(); // Non-existent user
      assigneeDisplayName = 'Unknown Person';
    }

    const rawParams = {
      clientId: overrides?.clientId ?? validClientId,
      projectId: overrides?.projectId ?? validProjectId,
      title: 'Deploy migration fallback procedure',
      description: 'Comprehensive recovery runbook execution',
      priority: 'high' as const,
      assigneeUserId,
      assigneeDisplayName,
      milestoneId: overrides?.invalidMilestoneId
        ? randomUUID()
        : 'b0000000-0000-4000-8000-000000000001',
      dueAt:
        overrides?.dueAt === null
          ? undefined
          : (overrides?.dueAt ?? '2026-10-18T18:00:00.000Z'),
    };

    const parameters =
      overrides?.customParameters ?? materializeTaskCreateParameters(rawParams);
    const paramHash = computeCanonicalParameterHash(parameters);

    const expiresAt =
      overrides?.proposalExpiresAt ?? '2026-10-16T12:00:00.000Z';
    const projectUpdatedAt =
      overrides?.projectUpdatedAt ?? '2026-10-14T10:00:00.000Z';

    const preconditions = [
      {
        entityType: 'project' as const,
        entityId: parameters.projectId,
        versionField: 'updated_at' as const,
        expectedValue: projectUpdatedAt,
      },
    ];

    const bindingHash = computeApprovalBindingHash({
      organizationId: orgId,
      actionType: 'task.create',
      parameters,
      preconditions,
      expiresAt,
    });

    const proposal: ActionProposal = {
      id: proposalId,
      organizationId: orgId,
      actionType: 'task.create',
      actionClass: 'WRITE',
      parameters,
      parameterHash: overrides?.paramHashMismatch
        ? '0000'.repeat(16)
        : paramHash,
      approvalBindingHash: overrides?.bindingHashMismatch
        ? '1111'.repeat(16)
        : bindingHash,
      correlationId: `corr-${proposalId}`,
      evidence: [
        {
          entityType: 'project',
          entityId: parameters.projectId,
          field: 'status',
          excerpt: 'status: active',
        },
      ],
      preconditions,
      status: overrides?.proposalStatus ?? 'APPROVED',
      justification: 'Recovery runbook for client migration',
      createdAt: '2026-10-15T10:00:00.000Z',
      expiresAt,
      updatedAt: '2026-10-15T11:00:00.000Z',
    };

    proposalRepo.proposals.set(`${orgId}:${proposalId}`, proposal);

    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: proposalId,
      organizationId: orgId,
      actorId: operatorActorId,
      actorRole: 'operator',
      decision: overrides?.approvalDecision ?? 'APPROVE',
      decidedAt: '2026-10-15T11:00:00.000Z',
      parameterHash: paramHash,
      approvalBindingHash: bindingHash,
      validUntil: overrides?.approvalValidUntil ?? '2026-10-16T11:00:00.000Z',
      comment: 'Approved during incident sync',
    };

    approvalRepo.approvals.set(`${orgId}:${proposalId}`, approval);

    const transactionRunner: TransactionRunner = async (fn) => fn({});

    return {
      proposalId,
      proposal,
      approval,
      proposalRepo,
      approvalRepo,
      executionRepo,
      taskMutationRepo,
      auditRepo,
      domainData,
      transactionRunner,
    };
  }

  // ==========================================================================
  // 1. AUTHORIZED SUCCESS
  // ==========================================================================
  describe('1. Authorized Success', () => {
    it('executes approved task.create proposal, creates exactly one task, and records terminal records', async () => {
      const ctx = await setupApprovedProposal();

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      // 1. Check returned execution result
      expect(result.status).toBe('COMPLETED');
      expect(result.idempotent).toBe(false);
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');

      // 2. Check created task business fields
      expect(result.task).toBeDefined();
      expect(result.task.organizationId).toBe(tenant.organizationId);
      expect(result.task.projectId).toBe(ctx.proposal.parameters.projectId);
      expect(result.task.title).toBe(ctx.proposal.parameters.title);
      expect(result.task.description).toBe(ctx.proposal.parameters.description);
      expect(result.task.priority).toBe('high');
      expect(result.task.status).toBe('open');
      expect(result.task.assigneeUserId).toBe(operatorActorId);
      expect(result.task.sourceActionProposalId).toBe(ctx.proposalId);

      // 3. Check proposal terminal status
      const updatedProposal = await ctx.proposalRepo.findById(
        tenant,
        ctx.proposalId,
      );
      expect(updatedProposal?.status).toBe('COMPLETED');

      // 4. Check action execution record
      const execution = await ctx.executionRepo.findByProposalId(
        tenant,
        ctx.proposalId,
      );
      expect(execution).toBeDefined();
      expect(execution?.status).toBe('COMPLETED');
      expect(execution?.targetEntityId).toBe(result.task.id);
      expect(execution?.completedAt).toBe(fixedClock.now().toISOString());
      expect(execution?.errorCode).toBeUndefined();
      expect(execution?.failureSummary).toBeUndefined();

      // 5. Check audit events sequence
      const auditEvents = ctx.auditRepo.getEvents();
      expect(auditEvents.length).toBe(2);
      expect(auditEvents[0]?.eventType).toBe('EXECUTION_STARTED');
      expect(auditEvents[0]?.actionProposalId).toBe(ctx.proposalId);
      expect(auditEvents[1]?.eventType).toBe('EXECUTION_COMPLETED');
      expect(auditEvents[1]?.actionProposalId).toBe(ctx.proposalId);
      expect(auditEvents[1]?.payload).toMatchObject({
        actionProposalId: ctx.proposalId,
        targetEntityId: result.task.id,
        targetEntityType: 'task',
      });
    });
  });

  // ==========================================================================
  // 2. AUTHORIZATION REJECTIONS
  // ==========================================================================
  describe('2. Authorization Rejections', () => {
    it('rejects execution if proposal status is PENDING_APPROVAL', async () => {
      const ctx = await setupApprovedProposal({
        proposalStatus: 'PENDING_APPROVAL',
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(InvalidProposalStatusError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if proposal status is DENIED', async () => {
      const ctx = await setupApprovedProposal({
        proposalStatus: 'DENIED',
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(InvalidProposalStatusError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if approval decision is DENY', async () => {
      const ctx = await setupApprovedProposal({
        approvalDecision: 'DENY',
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if approval record is missing', async () => {
      const ctx = await setupApprovedProposal();
      ctx.approvalRepo.approvals.clear();

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution across tenants (tenant isolation)', async () => {
      const wrongTenant = createTenantContext(SECOND_TEST_ORGANIZATION_ID);
      const ctx = await setupApprovedProposal();

      await expect(
        executeApprovedAction({
          tenant: wrongTenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ProposalNotFoundError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if approving actor was removed from users table', async () => {
      const ctx = await setupApprovedProposal();
      // Remove approving user from mock user repository
      const idx = ctx.domainData.users.findIndex(
        (u) => u.id === operatorActorId,
      );
      if (idx !== -1) ctx.domainData.users.splice(idx, 1);

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(UnauthorizedApproverError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if approving actor was downgraded to viewer role', async () => {
      const ctx = await setupApprovedProposal();
      const user = ctx.domainData.users.find((u) => u.id === operatorActorId);
      if (user) user.role = 'viewer';

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(UnauthorizedApproverError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if proposal parameter hash was tampered', async () => {
      const ctx = await setupApprovedProposal({
        paramHashMismatch: true,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ProposalTamperedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('rejects execution if approval binding hash was tampered', async () => {
      const ctx = await setupApprovedProposal({
        bindingHashMismatch: true,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ProposalTamperedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('transitions to EXPIRED and returns EXPIRED result when proposal expires before execution', async () => {
      const ctx = await setupApprovedProposal({
        proposalExpiresAt: '2026-10-15T11:59:59.000Z', // 1 second before fixedClock (12:00:00)
      });

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('EXPIRED');
      if (result.status === 'EXPIRED') {
        expect(result.reason).toBe('PROPOSAL_EXPIRED');
        expect(result.idempotent).toBe(false);
        expect(result.proposal.status).toBe('EXPIRED');
      }

      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      expect(proposal?.status).toBe('EXPIRED');

      const auditEvents = ctx.auditRepo.getEvents();
      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0]?.eventType).toBe('ACTION_EXPIRED');
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('transitions to EXPIRED and returns EXPIRED result when approval validity period expires', async () => {
      const ctx = await setupApprovedProposal({
        approvalValidUntil: '2026-10-15T11:59:59.000Z', // expired
      });

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('EXPIRED');
      if (result.status === 'EXPIRED') {
        expect(result.reason).toBe('APPROVAL_EXPIRED');
        expect(result.idempotent).toBe(false);
        expect(result.proposal.status).toBe('EXPIRED');
      }

      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      expect(proposal?.status).toBe('EXPIRED');
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('returns EXPIRED idempotently when proposal is already in EXPIRED status with PROPOSAL_EXPIRED', async () => {
      const ctx = await setupApprovedProposal({
        proposalStatus: 'EXPIRED',
        proposalExpiresAt: '2026-10-15T09:00:00.000Z',
        approvalValidUntil: '2026-10-15T15:00:00.000Z',
      });

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('EXPIRED');
      if (result.status === 'EXPIRED') {
        expect(result.reason).toBe('PROPOSAL_EXPIRED');
        expect(result.idempotent).toBe(true);
      }
    });

    it('returns EXPIRED idempotently when proposal is already in EXPIRED status with APPROVAL_EXPIRED', async () => {
      const ctx = await setupApprovedProposal({
        proposalStatus: 'EXPIRED',
        proposalExpiresAt: '2026-10-16T12:00:00.000Z',
        approvalValidUntil: '2026-10-15T09:00:00.000Z',
      });

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('EXPIRED');
      if (result.status === 'EXPIRED') {
        expect(result.reason).toBe('APPROVAL_EXPIRED');
        expect(result.idempotent).toBe(true);
      }
    });
  });

  // ==========================================================================
  // 3. TOCTOU & RELATIONSHIPS
  // ==========================================================================
  describe('3. TOCTOU & Business Relationships', () => {
    it('fails closed if target project updated_at changed after proposal creation (TOCTOU violation)', async () => {
      const ctx = await setupApprovedProposal({
        projectUpdatedAt: '2026-10-13T00:00:00.000Z', // Proposal expected 2026-10-13, but store has 2026-10-14T10:00:00.000Z
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('fails closed if target project does not exist', async () => {
      const ctx = await setupApprovedProposal({
        projectId: randomUUID(),
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('fails closed if project and client mismatch', async () => {
      const ctx = await setupApprovedProposal({
        clientId: 'c0000000-0000-4000-8000-000000000002', // Northstar, but project belongs to c0000000-0000-4000-8000-000000000001
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('fails closed if milestone does not exist for project', async () => {
      const ctx = await setupApprovedProposal({
        invalidMilestoneId: true,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('fails closed if assignee display name is provided without authoritative assigneeUserId', async () => {
      const ctx = await setupApprovedProposal({
        assigneeDisplayNameWithoutId: true,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });

    it('fails closed if assigneeUserId does not exist in tenant', async () => {
      const ctx = await setupApprovedProposal({
        invalidAssigneeUserId: true,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);

      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });
  });

  // ==========================================================================
  // 4. IDEMPOTENCY
  // ==========================================================================
  describe('4. Idempotency', () => {
    it('returns existing task and execution record idempotently on repeated calls', async () => {
      const ctx = await setupApprovedProposal();

      // First execution: creates task
      const firstResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(firstResult.status).toBe('COMPLETED');
      expect(firstResult.idempotent).toBe(false);
      expect(ctx.taskMutationRepo.tasks.size).toBe(1);

      // Second execution: returns exact same task idempotently without inserting duplicate
      const secondResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(secondResult.status).toBe('COMPLETED');
      expect(secondResult.idempotent).toBe(true);
      if (
        secondResult.status !== 'COMPLETED' ||
        firstResult.status !== 'COMPLETED'
      ) {
        throw new Error('Expected COMPLETED');
      }
      expect(secondResult.task.id).toBe(firstResult.task.id);
      expect(ctx.taskMutationRepo.tasks.size).toBe(1);

      // No duplicate audit events on idempotent retry
      expect(ctx.auditRepo.getEvents().length).toBe(2);
    });
  });

  // ==========================================================================
  // 5. RECOVERABLE FAILURE PATH
  // ==========================================================================
  describe('5. Recoverable Mutation Failure', () => {
    it('handles simulated task mutation failure: rolls back, marks FAILED, appends EXECUTION_FAILED', async () => {
      const ctx = await setupApprovedProposal();
      ctx.taskMutationRepo.shouldFailMutation = true;

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('FAILED');
      expect(result.idempotent).toBe(false);
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');

      expect(result.errorCode).toBe('TASK_CREATION_FAILED');
      expect(result.failureSummary).toBe(
        'Task creation business validation or database insertion failed.',
      );

      // Zero task rows
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);

      // Proposal transitioned to FAILED
      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      expect(proposal?.status).toBe('FAILED');

      // Execution marked FAILED
      const execution = await ctx.executionRepo.findByProposalId(
        tenant,
        ctx.proposalId,
      );
      expect(execution?.status).toBe('FAILED');
      expect(execution?.errorCode).toBe('TASK_CREATION_FAILED');

      // Audit events: EXECUTION_STARTED, then EXECUTION_FAILED
      const events = ctx.auditRepo.getEvents();
      expect(events.length).toBe(2);
      expect(events[0]?.eventType).toBe('EXECUTION_STARTED');
      expect(events[1]?.eventType).toBe('EXECUTION_FAILED');
    });

    it('returns existing failure idempotently on retry of a FAILED proposal', async () => {
      const ctx = await setupApprovedProposal();
      ctx.taskMutationRepo.shouldFailMutation = true;

      // First run fails
      await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      // Second run returns existing failure idempotently
      const retryResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(retryResult.status).toBe('FAILED');
      expect(retryResult.idempotent).toBe(true);
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });
  });

  // ==========================================================================
  // 6. RECONCILIATION INVARIANTS & INTEGRITY CONFLICTS
  // ==========================================================================
  describe('6. Reconciliation Invariants & Integrity Conflicts', () => {
    it('throws ConflictError if COMPLETED execution targetEntityId mismatches task id', async () => {
      const ctx = await setupApprovedProposal();
      await ctx.executionRepo.create({
        organizationId: tenant.organizationId,
        actionProposalId: ctx.proposalId,
        actionApprovalId: randomUUID(),
        executorPrincipal: 'clientops_trusted_executor',
        parameterHash: '0'.repeat(64),
        approvalBindingHash: '0'.repeat(64),
        startedAt: new Date().toISOString(),
      });
      await ctx.executionRepo.updateResult(tenant, ctx.proposalId, {
        status: 'COMPLETED',
        targetEntityId: randomUUID(), // Divergent target entity ID!
        completedAt: new Date().toISOString(),
      });
      await ctx.taskMutationRepo.createControlledTask(tenant, {
        projectId: validProjectId,
        title: 'Task title',
        priority: 'medium',
        sourceActionProposalId: ctx.proposalId,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if execution is FAILED but a task exists in store', async () => {
      const ctx = await setupApprovedProposal();
      await ctx.executionRepo.create({
        organizationId: tenant.organizationId,
        actionProposalId: ctx.proposalId,
        actionApprovalId: randomUUID(),
        executorPrincipal: 'clientops_trusted_executor',
        parameterHash: '0'.repeat(64),
        approvalBindingHash: '0'.repeat(64),
        startedAt: new Date().toISOString(),
      });
      await ctx.executionRepo.updateResult(tenant, ctx.proposalId, {
        status: 'FAILED',
        errorCode: 'TASK_CREATION_FAILED',
        failureSummary: 'Failure',
        completedAt: new Date().toISOString(),
      });
      await ctx.taskMutationRepo.createControlledTask(tenant, {
        projectId: validProjectId,
        title: 'Task title',
        priority: 'medium',
        sourceActionProposalId: ctx.proposalId,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if task exists for proposal without any execution record', async () => {
      const ctx = await setupApprovedProposal();
      await ctx.taskMutationRepo.createControlledTask(tenant, {
        projectId: validProjectId,
        title: 'Orphaned Task',
        priority: 'medium',
        sourceActionProposalId: ctx.proposalId,
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if COMPLETED execution has proposal.status !== "COMPLETED"', async () => {
      const ctx = await setupApprovedProposal();
      const execResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });
      expect(execResult.status).toBe('COMPLETED');

      // Corrupt proposal status to 'APPROVED' while execution is 'COMPLETED'
      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      await ctx.proposalRepo.create({
        ...proposal!,
        status: 'APPROVED',
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if COMPLETED execution has missing approval record', async () => {
      const ctx = await setupApprovedProposal();
      const execResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });
      expect(execResult.status).toBe('COMPLETED');

      // Remove the approval record
      ctx.approvalRepo.approvals.delete(
        `${tenant.organizationId}:${ctx.proposalId}`,
      );

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if FAILED execution has proposal.status !== "FAILED"', async () => {
      const ctx = await setupApprovedProposal();
      ctx.taskMutationRepo.shouldFailMutation = true;
      const failResult = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });
      expect(failResult.status).toBe('FAILED');

      // Corrupt proposal status to 'APPROVED' while execution is 'FAILED'
      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      await ctx.proposalRepo.create({
        ...proposal!,
        status: 'APPROVED',
      });

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws PreconditionFailedError if assignee display name does not match user name at execution', async () => {
      const ctx = await setupApprovedProposal();
      // Tamper proposal parameters to have mismatched assignee name but valid hashes for test
      const proposal = await ctx.proposalRepo.findById(tenant, ctx.proposalId);
      if (!proposal) throw new Error('Proposal not found');
      const tamperedParams = {
        ...proposal.parameters,
        assigneeDisplayName: 'Completely Different Name',
      };
      const newParamHash = computeCanonicalParameterHash(tamperedParams);
      const newBindingHash = computeApprovalBindingHash({
        organizationId: proposal.organizationId,
        actionType: proposal.actionType,
        parameters: tamperedParams,
        preconditions: proposal.preconditions,
        expiresAt: proposal.expiresAt,
      });
      await ctx.proposalRepo.create({
        ...proposal,
        parameters: tamperedParams,
        parameterHash: newParamHash,
        approvalBindingHash: newBindingHash,
      });
      // Also update approval with matching hashes so step 7 passes and step 8 checks name
      const approval = await ctx.approvalRepo.findByProposalId(
        tenant,
        ctx.proposalId,
      );
      if (approval) {
        ctx.approvalRepo.approvals.set(
          `${tenant.organizationId}:${ctx.proposalId}`,
          {
            ...approval,
            parameterHash: newParamHash,
            approvalBindingHash: newBindingHash,
          },
        );
      }

      await expect(
        executeApprovedAction({
          tenant,
          proposalId: ctx.proposalId,
          repositories: {
            actionProposalRepository: ctx.proposalRepo,
            actionApprovalRepository: ctx.approvalRepo,
            actionExecutionRepository: ctx.executionRepo,
            auditEventRepository: ctx.auditRepo,
            controlledTaskMutationRepository: ctx.taskMutationRepo,
            userRepository: ctx.domainData.userRepository,
            projectRepository: ctx.domainData.projectRepository,
            milestoneRepository: ctx.domainData.milestoneRepository,
          },
          transactionRunner: ctx.transactionRunner,
          clock: fixedClock,
        }),
      ).rejects.toThrow(PreconditionFailedError);
    });
  });

  describe('8. Readback Temporal Equivalence & Mismatch Hardening', () => {
    it('A. semantic match: approved dueAt "2026-10-16T09:00:00Z" matches readback "2026-10-16T09:00:00.000Z"', async () => {
      const ctx = await setupApprovedProposal();
      const rawNonMsParams = {
        ...ctx.proposal.parameters,
        dueAt: '2026-10-16T09:00:00Z',
      };
      const pHash = computeCanonicalParameterHash(rawNonMsParams);
      const bHash = computeApprovalBindingHash({
        organizationId: tenant.organizationId,
        actionType: 'task.create',
        parameters: rawNonMsParams,
        preconditions: ctx.proposal.preconditions,
        expiresAt: ctx.proposal.expiresAt,
      });
      ctx.proposalRepo.proposals.set(
        `${tenant.organizationId}:${ctx.proposalId}`,
        {
          ...ctx.proposal,
          parameters: rawNonMsParams,
          parameterHash: pHash,
          approvalBindingHash: bHash,
        },
      );
      ctx.approvalRepo.approvals.set(
        `${tenant.organizationId}:${ctx.proposalId}`,
        {
          ...ctx.approval,
          parameterHash: pHash,
          approvalBindingHash: bHash,
        },
      );

      const origFindById = ctx.taskMutationRepo.findById.bind(
        ctx.taskMutationRepo,
      );
      ctx.taskMutationRepo.findById = async (t: TenantContext, id: string) => {
        const task = await origFindById(t, id);
        if (!task) return null;
        return { ...task, dueAt: '2026-10-16T09:00:00.000Z' };
      };

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(
        sameOptionalInstant(result.task.dueAt, '2026-10-16T09:00:00.000Z'),
      ).toBe(true);
    });

    it('B. exact match: approved dueAt "2026-10-16T09:00:00.000Z" matches readback "2026-10-16T09:00:00.000Z"', async () => {
      const ctx = await setupApprovedProposal({
        dueAt: '2026-10-16T09:00:00.000Z',
      });

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(result.task.dueAt).toBe('2026-10-16T09:00:00.000Z');
    });

    it('C. mismatch: approved dueAt "2026-10-16T09:00:00.000Z" vs readback "2026-10-16T09:00:00.001Z" rolls back to FAILED with 0 tasks', async () => {
      const ctx = await setupApprovedProposal({
        dueAt: '2026-10-16T09:00:00.000Z',
      });

      let rolledBack = false;
      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('ROLLBACK TO SAVEPOINT task_mutation')) {
            rolledBack = true;
            ctx.taskMutationRepo.tasks.clear();
            ctx.taskMutationRepo.tasksByProposal.clear();
          }
        },
      };

      const origFindById = ctx.taskMutationRepo.findById.bind(
        ctx.taskMutationRepo,
      );
      ctx.taskMutationRepo.findById = async (t: TenantContext, id: string) => {
        const task = await origFindById(t, id);
        if (!task) return null;
        return { ...task, dueAt: '2026-10-16T09:00:00.001Z' };
      };

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: async (fn) =>
          fn({
            client: mockClient as unknown as DbClient,
          }),
        clock: fixedClock,
      });

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.errorCode).toBe('TASK_CREATION_FAILED');
      expect(rolledBack).toBe(true);
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);

      const dbProposal = await ctx.proposalRepo.findById(
        tenant,
        ctx.proposalId,
      );
      expect(dbProposal?.status).toBe('FAILED');
    });

    it('D. match: approved dueAt absent and readback dueAt absent', async () => {
      const ctx = await setupApprovedProposal({
        dueAt: null,
      });
      expect(ctx.proposal.parameters.dueAt).toBeUndefined();

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: ctx.transactionRunner,
        clock: fixedClock,
      });

      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(result.task.dueAt).toBeUndefined();
    });

    it('E. mismatch: approved dueAt absent but readback dueAt unexpectedly present', async () => {
      const ctx = await setupApprovedProposal({
        dueAt: null,
      });
      expect(ctx.proposal.parameters.dueAt).toBeUndefined();

      let rolledBack = false;
      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('ROLLBACK TO SAVEPOINT task_mutation')) {
            rolledBack = true;
            ctx.taskMutationRepo.tasks.clear();
            ctx.taskMutationRepo.tasksByProposal.clear();
          }
        },
      };

      const origFindById = ctx.taskMutationRepo.findById.bind(
        ctx.taskMutationRepo,
      );
      ctx.taskMutationRepo.findById = async (t: TenantContext, id: string) => {
        const task = await origFindById(t, id);
        if (!task) return null;
        return { ...task, dueAt: '2026-10-16T09:00:00.000Z' };
      };

      const result = await executeApprovedAction({
        tenant,
        proposalId: ctx.proposalId,
        repositories: {
          actionProposalRepository: ctx.proposalRepo,
          actionApprovalRepository: ctx.approvalRepo,
          actionExecutionRepository: ctx.executionRepo,
          auditEventRepository: ctx.auditRepo,
          controlledTaskMutationRepository: ctx.taskMutationRepo,
          userRepository: ctx.domainData.userRepository,
          projectRepository: ctx.domainData.projectRepository,
          milestoneRepository: ctx.domainData.milestoneRepository,
        },
        transactionRunner: async (fn) =>
          fn({
            client: mockClient as unknown as DbClient,
          }),
        clock: fixedClock,
      });

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.errorCode).toBe('TASK_CREATION_FAILED');
      expect(rolledBack).toBe(true);
      expect(ctx.taskMutationRepo.tasks.size).toBe(0);
    });
  });
});
