import { describe, expect, it } from 'vitest';
import {
  DEMO_ORGANIZATION_ID,
  SECOND_TEST_ORGANIZATION_ID,
  createTenantContext,
  FixedClock,
  type RepositoryTransactionOptions,
} from '@clientops/domain';
import {
  MockActionProposalRepository,
  MockActionApprovalRepository,
  MockAuditEventRepository,
  createMockDomainData,
} from './test-helpers.js';
import type { TaskEntity } from '@clientops/domain';
import type {
  ActionStatus,
  CreateActionProposalInput,
  RecordVersionPrecondition,
  TrustedActorContext,
} from '@clientops/contracts';
import {
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
  materializeTaskCreateParameters,
} from '@clientops/contracts';
import {
  resolveApprovalDecision,
  getProposalForReview,
  ConflictError,
  ProposalExpiredError,
  UnauthorizedApproverError,
  ProposalTamperedError,
  InvalidProposalStatusError,
  type TransactionRunner,
} from './index.js';

describe('Phase 4.2 Human Approval Decision Service', () => {
  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
  const fixedClock = new FixedClock('2026-10-15T12:00:00.000Z');

  // Test fixtures from demo seed data
  const validClientId = 'c0000000-0000-4000-8000-000000000001';
  const validProjectId = 'a0000000-0000-4000-8000-000000000001';
  const operatorActorId = '10000000-0000-4000-8000-000000000011'; // Alice Walker, Operator
  const adminActorId = '10000000-0000-4000-8000-000000000001'; // Gabe Martinez, Admin
  const viewerActorId = '10000000-0000-4000-8000-000000000004'; // Elena Rostova, Viewer

  const operatorActor: TrustedActorContext = {
    organizationId: tenant.organizationId,
    actorId: operatorActorId,
    role: 'operator',
    source: 'local_demo_adapter',
    isProductionActor: false,
  };

  const adminActor: TrustedActorContext = {
    organizationId: tenant.organizationId,
    actorId: adminActorId,
    role: 'admin',
    source: 'local_demo_adapter',
    isProductionActor: false,
  };

  const viewerActor: TrustedActorContext = {
    organizationId: tenant.organizationId,
    actorId: viewerActorId,
    role: 'viewer' as unknown as 'operator',
    source: 'local_demo_adapter',
    isProductionActor: false,
  };

  async function createPendingProposal(
    actionProposalRepo: MockActionProposalRepository,
    overrides?: {
      expiresAt?: string;
      parameterHash?: string;
      approvalBindingHash?: string;
      status?: ActionStatus;
    },
  ) {
    const rawParams = {
      clientId: validClientId,
      projectId: validProjectId,
      title: 'Setup Executive Incident Briefing',
      priority: 'high' as const,
    };
    const canonicalParams = materializeTaskCreateParameters(rawParams);
    const preconditions: RecordVersionPrecondition[] = [
      {
        entityType: 'project',
        entityId: validProjectId,
        versionField: 'updated_at',
        expectedValue: '2026-10-14T10:00:00.000Z',
      },
    ];
    const createdAt = '2026-10-15T09:00:00.000Z';
    const expiresAt = overrides?.expiresAt ?? '2026-10-16T09:00:00.000Z';

    const parameterHash =
      overrides?.parameterHash ??
      computeCanonicalParameterHash(canonicalParams);
    const approvalBindingHash =
      overrides?.approvalBindingHash ??
      computeApprovalBindingHash({
        organizationId: tenant.organizationId,
        actionType: 'task.create',
        parameters: canonicalParams,
        preconditions,
        expiresAt,
      });

    const proposalInput: CreateActionProposalInput = {
      id: '50000000-0000-4000-8000-000000000001',
      organizationId: tenant.organizationId,
      actionType: 'task.create',
      actionClass: 'WRITE',
      parameters: canonicalParams,
      parameterHash,
      approvalBindingHash,
      correlationId: 'test-corr-101',
      evidence: [
        {
          entityType: 'meeting',
          entityId: '40000000-0000-4000-8000-000000000001',
          field: 'summary',
          excerpt: 'Critical concerns noted',
        },
      ],
      preconditions,
      status: 'PROPOSED',
      justification: 'Urgent resolution required',
      createdAt,
      expiresAt,
    };

    const created = await actionProposalRepo.create(proposalInput);
    if (overrides?.status && overrides.status !== 'PENDING_APPROVAL') {
      return created;
    }
    return await actionProposalRepo.transitionStatus(
      tenant,
      proposalInput.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
  }

  function setupEnvironment() {
    const mockData = createMockDomainData();
    mockData.users.push(
      {
        id: operatorActorId,
        organizationId: tenant.organizationId,
        email: 'alice@clientops.demo',
        name: 'Alice Walker',
        role: 'operator',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: adminActorId,
        organizationId: tenant.organizationId,
        email: 'gabe@clientops.demo',
        name: 'Gabe Martinez',
        role: 'admin',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: viewerActorId,
        organizationId: tenant.organizationId,
        email: 'elena@clientops.demo',
        name: 'Elena Rostova',
        role: 'viewer',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    );
    const actionProposalRepo = new MockActionProposalRepository();
    const actionApprovalRepo = new MockActionApprovalRepository();
    const auditEventRepo = new MockAuditEventRepository();
    const testTxRunner = async <T>(
      fn: (txOptions: RepositoryTransactionOptions) => Promise<T>,
    ): Promise<T> => fn({});

    return {
      mockData,
      actionProposalRepo,
      actionApprovalRepo,
      auditEventRepo,
      transactionRunner: testTxRunner,
      repositories: {
        actionProposalRepository: actionProposalRepo,
        actionApprovalRepository: actionApprovalRepo,
        auditEventRepository: auditEventRepo,
        userRepository: mockData.userRepository,
        clientRepository: mockData.clientRepository,
        projectRepository: mockData.projectRepository,
      },
    };
  }

  it('12. valid operator APPROVE transitions proposal to APPROVED and appends ACTION_APPROVED', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const result = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE', comment: 'Approved for migration risk' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(result.idempotent).toBe(false);
    expect(result.proposal.status).toBe('APPROVED');
    expect(result.approval.decision).toBe('APPROVE');
    expect(result.approval.actorId).toBe(operatorActorId);
    expect(result.approval.actorRole).toBe('operator');
    expect(result.approval.comment).toBe('Approved for migration risk');
    expect(result.approval.decidedAt).toBe('2026-10-15T12:00:00.000Z');

    // Audit event created
    const events = env.auditEventRepo.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe('ACTION_APPROVED');
    expect(events[0]!.actionProposalId).toBe(pending.id);
    expect(events[0]!.actorId).toBe(operatorActorId);
  });

  it('13. valid admin APPROVE transitions proposal to APPROVED', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const result = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE', comment: 'Admin fast-track approval' },
      actor: adminActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(result.proposal.status).toBe('APPROVED');
    expect(result.approval.actorRole).toBe('admin');
  });

  it('14. valid operator DENY transitions proposal to DENIED and appends ACTION_DENIED', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const result = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: {
        decision: 'DENY',
        comment: 'Scope not authorized at this time',
      },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(result.proposal.status).toBe('DENIED');
    expect(result.approval.decision).toBe('DENY');

    const events = env.auditEventRepo.getEvents();
    expect(events[0]!.eventType).toBe('ACTION_DENIED');
  });

  it('15. viewer rejected from approval decisions', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: viewerActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(UnauthorizedApproverError);
  });

  it('16. actor tenant mismatch rejected', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const foreignActor: TrustedActorContext = {
      ...operatorActor,
      organizationId: SECOND_TEST_ORGANIZATION_ID,
    };

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: foreignActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(UnauthorizedApproverError);
  });

  it('17. request body actorId rejected', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE', actorId: 'hacked-id' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/Invalid approval decision request/);
  });

  it('18. request body organizationId rejected', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE', organizationId: 'hacked-org' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/Invalid approval decision request/);
  });

  it('19. request body hashes/status rejected', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: {
          decision: 'APPROVE',
          status: 'APPROVED',
          parameterHash: 'fake',
        },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/Invalid approval decision request/);
  });

  it('20. expired pending proposal rejected', async () => {
    const env = setupEnvironment();
    // Proposal expired at 2026-10-15T08:00:00Z (before clock 12:00:00Z)
    const pending = await createPendingProposal(env.actionProposalRepo, {
      expiresAt: '2026-10-15T08:00:00.000Z',
    });

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ProposalExpiredError);
  });

  it('20b. non-PENDING_APPROVAL proposal rejected with InvalidProposalStatusError', async () => {
    const env = setupEnvironment();
    const proposed = await createPendingProposal(env.actionProposalRepo, {
      status: 'PROPOSED',
    });

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: proposed.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(InvalidProposalStatusError);
  });

  it('21. tampered durable hash rejected', async () => {
    const env = setupEnvironment();
    // Proposal with forged parameter hash
    const pending = await createPendingProposal(env.actionProposalRepo, {
      parameterHash: 'f'.repeat(64),
    });

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ProposalTamperedError);
  });

  it('22. approval role escalation rejected', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    // Operator claims to be 'admin' in actor context
    const escalatedActor: TrustedActorContext = {
      ...operatorActor,
      role: 'admin',
    };

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: escalatedActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(UnauthorizedApproverError);
  });

  it('23. same-decision retry is idempotent', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const first = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE', comment: 'Initial approval' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });
    expect(first.idempotent).toBe(false);

    // Retry with identical decision
    const second = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE', comment: 'Duplicate click' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(second.idempotent).toBe(true);
    expect(second.approval.id).toBe(first.approval.id);
    expect(env.auditEventRepo.getEvents().length).toBe(1); // No duplicate audit event
  });

  it('24. opposite-decision retry returns conflict', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    // Opposite decision attempted
    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'DENY' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('25. concurrent duplicate decision produces one immutable approval', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    // Run two identical decisions concurrently
    const [res1, res2] = await Promise.all([
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ]);

    expect(res1.approval.id).toBe(res2.approval.id);
    expect(res1.idempotent !== res2.idempotent).toBe(true);
  });

  it('26. APPROVED stops at APPROVED — no execution/task', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const result = await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(result.proposal.status).toBe('APPROVED');
    // Ensure no tasks were created in business repository
    const tasks = await env.mockData.taskRepository.listByProject(
      tenant,
      validProjectId,
    );
    expect(
      tasks.filter((t: TaskEntity) => t.title === pending.parameters.title),
    ).toHaveLength(0);
  });

  it('27. DENIED is terminal', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'DENY' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    // Cannot later approve
    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('28. no task row created during approval lifecycle', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const initialTasks = await env.mockData.taskRepository.listByProject(
      tenant,
      validProjectId,
    );

    await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    const finalTasks = await env.mockData.taskRepository.listByProject(
      tenant,
      validProjectId,
    );
    expect(finalTasks.length).toBe(initialTasks.length);
  });

  it('Inspection read boundary returns tenant-scoped detail without internal hashes', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    const detail = await getProposalForReview(tenant, pending.id, {
      actionProposalRepository: env.actionProposalRepo,
      clientRepository: env.mockData.clientRepository,
      projectRepository: env.mockData.projectRepository,
    });

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(pending.id);
    expect(detail!.client.name).toBe('Acme Labs');
    expect(detail!.project.name).toBe('Cloud Analytics Migration');
    expect(detail!.task.title).toBe(pending.parameters.title);
    expect(detail!.status).toBe('PENDING_APPROVAL');

    // Internal hashes are NOT exposed in review detail
    expect(detail).not.toHaveProperty('parameterHash');
    expect(detail).not.toHaveProperty('approvalBindingHash');
  });

  it('29. missing transactionRunner throws Error fail-closed', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: operatorActor,
        repositories: env.repositories,
        transactionRunner: undefined as unknown as TransactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/mandatory TransactionRunner must be provided/);
  });

  it('30. invalid validityDurationMs (zero, negative, NaN, non-finite, excessive) rejected fail-closed', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    for (const invalidDuration of [
      0,
      -1000,
      NaN,
      Infinity,
      -Infinity,
      31 * 24 * 60 * 60 * 1000,
    ]) {
      await expect(
        resolveApprovalDecision({
          tenant,
          proposalId: pending.id,
          request: { decision: 'APPROVE' },
          actor: operatorActor,
          repositories: env.repositories,
          transactionRunner: env.transactionRunner,
          clock: fixedClock,
          validityDurationMs: invalidDuration,
        }),
      ).rejects.toThrow(/Invalid approval validity duration/);
    }
  });

  it('31. authorize actor before idempotency: unauthorized viewer retrying approved proposal is rejected with 403 / UnauthorizedApproverError', async () => {
    const env = setupEnvironment();
    const pending = await createPendingProposal(env.actionProposalRepo);

    // Operator legitimately approves the proposal first
    await resolveApprovalDecision({
      tenant,
      proposalId: pending.id,
      request: { decision: 'APPROVE', comment: 'Legitimate approval' },
      actor: operatorActor,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    // An unauthorized viewer attempts to resolve or retry the already-approved proposal
    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: viewerActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(UnauthorizedApproverError);

    // An actor from a foreign tenant also rejected before returning idempotent approval
    const foreignActor: TrustedActorContext = {
      ...operatorActor,
      organizationId: SECOND_TEST_ORGANIZATION_ID,
    };

    await expect(
      resolveApprovalDecision({
        tenant,
        proposalId: pending.id,
        request: { decision: 'APPROVE' },
        actor: foreignActor,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(UnauthorizedApproverError);
  });
});
