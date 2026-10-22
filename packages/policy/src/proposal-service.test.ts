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
  MockAuditEventRepository,
  createMockDomainData,
} from './test-helpers.js';
import {
  registerActionProposal,
  ProposalRegistrationError,
  DEFAULT_PROPOSAL_TTL_MS,
  type AuthoritativeEvidenceResolver,
  type TransactionRunner,
} from './index.js';
import type { ModelEvidenceCitation, EvidenceRef } from '@clientops/contracts';

describe('Phase 4.2 Proposal Registration Service', () => {
  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
  const fixedClock = new FixedClock('2026-10-15T10:00:00.000Z');

  // Authoritative IDs from demo seed
  const validClientId = 'c0000000-0000-4000-8000-000000000001'; // Acme Labs
  const validProjectId = 'a0000000-0000-4000-8000-000000000001'; // Cloud Analytics Migration

  // Mock Evidence Resolver
  const mockEvidenceRegistry: Record<string, EvidenceRef> = {
    'meeting:40000000-0000-4000-8000-000000000001': {
      entityType: 'meeting',
      entityId: '40000000-0000-4000-8000-000000000001',
      field: 'summary',
      excerpt:
        'Client expressed critical concerns regarding analytics cutover date.',
    },
    'milestone:20000000-0000-4000-8000-000000000001': {
      entityType: 'milestone',
      entityId: '20000000-0000-4000-8000-000000000001',
      field: 'title',
      excerpt: 'Data Migration Phase 1 is 2 days overdue.',
    },
  };

  const evidenceResolver: AuthoritativeEvidenceResolver = {
    resolveCitation: (citation: ModelEvidenceCitation) => {
      const key = `${citation.entityType}:${citation.entityId}`;
      const found = mockEvidenceRegistry[key];
      if (!found) {
        return {
          success: false,
          error: 'Entity citation not found in registry',
        };
      }
      return { success: true, resolved: found };
    },
  };

  const testTxRunner = async <T>(
    fn: (txOptions: RepositoryTransactionOptions) => Promise<T>,
  ): Promise<T> => fn({});

  function setupTestEnvironment() {
    const mockData = createMockDomainData();
    const actionProposalRepo = new MockActionProposalRepository();
    const auditEventRepo = new MockAuditEventRepository();

    return {
      mockData,
      actionProposalRepo,
      auditEventRepo,
      transactionRunner: testTxRunner,
      repositories: {
        clientRepository: mockData.clientRepository,
        projectRepository: mockData.projectRepository,
        actionProposalRepository: actionProposalRepo,
        auditEventRepository: auditEventRepo,
        userRepository: mockData.userRepository,
        milestoneRepository: mockData.milestoneRepository,
      },
    };
  }

  const validModelInput = {
    actionType: 'task.create' as const,
    parameters: {
      clientId: validClientId,
      projectId: validProjectId,
      title: 'Schedule executive alignment meeting',
      description: 'Discuss delayed cutover and mitigation schedule.',
      priority: 'high' as const,
    },
    justification:
      'Data migration milestone is overdue and requires client alignment.',
    citations: [
      {
        entityType: 'meeting' as const,
        entityId: '40000000-0000-4000-8000-000000000001',
        field: 'summary',
      },
    ],
  };

  it('1. valid grounded model proposal -> PROPOSED -> PENDING_APPROVAL atomically', async () => {
    const env = setupTestEnvironment();

    const registered = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-001',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(registered.id).toBeDefined();
    expect(registered.organizationId).toBe(tenant.organizationId);
    expect(registered.status).toBe('PENDING_APPROVAL');
    expect(registered.actionType).toBe('task.create');
    expect(registered.actionClass).toBe('WRITE');
    expect(registered.createdAt).toBe('2026-10-15T10:00:00.000Z');
    expect(registered.expiresAt).toBe(
      new Date(
        fixedClock.now().getTime() + DEFAULT_PROPOSAL_TTL_MS,
      ).toISOString(),
    );

    // Audit events verified
    const events = env.auditEventRepo.getEvents();
    expect(events.length).toBe(2);
    expect(events[0]!.eventType).toBe('ACTION_PROPOSED');
    expect(events[0]!.actionProposalId).toBe(registered.id);
    expect(events[1]!.eventType).toBe('APPROVAL_REQUESTED');
    expect(events[1]!.actionProposalId).toBe(registered.id);
  });

  it('2. canonical parameters materialized server-side with defaults populated', async () => {
    const env = setupTestEnvironment();

    const minimalInput = {
      actionType: 'task.create' as const,
      parameters: {
        clientId: validClientId,
        projectId: validProjectId,
        title: 'Minimal task title',
      },
      justification: 'Necessary action',
      citations: [
        {
          entityType: 'milestone' as const,
          entityId: '20000000-0000-4000-8000-000000000001',
        },
      ],
    };

    const registered = await registerActionProposal({
      tenant,
      modelInput: minimalInput,
      correlationId: 'req-corr-002',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(registered.parameters.priority).toBe('medium'); // Default materialized
    expect(registered.parameters.title).toBe('Minimal task title');
    expect(registered.parameterHash).toHaveLength(64);
  });

  it('3. evidence pointers hydrated from authoritative registry (excerpts preserved)', async () => {
    const env = setupTestEnvironment();

    const registered = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-003',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(registered.evidence).toHaveLength(1);
    expect(registered.evidence[0]).toEqual({
      entityType: 'meeting',
      entityId: '40000000-0000-4000-8000-000000000001',
      field: 'summary',
      excerpt:
        'Client expressed critical concerns regarding analytics cutover date.',
    });
  });

  it('4. fabricated citation rejects registration', async () => {
    const env = setupTestEnvironment();

    const fabricatedInput = {
      ...validModelInput,
      citations: [
        {
          entityType: 'meeting' as const,
          entityId: '99999999-9999-4000-8000-999999999999', // Non-existent
        },
      ],
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: fabricatedInput,
        correlationId: 'req-corr-004',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/Evidence resolution failed/);
  });

  it('5. wrong-tenant client rejects', async () => {
    const env = setupTestEnvironment();
    const wrongTenant = createTenantContext(SECOND_TEST_ORGANIZATION_ID);

    await expect(
      registerActionProposal({
        tenant: wrongTenant,
        modelInput: validModelInput,
        correlationId: 'req-corr-005',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ProposalRegistrationError);
  });

  it('6. wrong-tenant project rejects', async () => {
    const env = setupTestEnvironment();
    // Non-existent or other tenant project
    const invalidProjectInput = {
      ...validModelInput,
      parameters: {
        ...validModelInput.parameters,
        projectId: '20000000-0000-4000-8000-000000000099',
      },
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: invalidProjectInput,
        correlationId: 'req-corr-006',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(ProposalRegistrationError);
  });

  it('7. project/client relationship mismatch rejects', async () => {
    const env = setupTestEnvironment();
    // Northstar Health clientId with Acme Labs projectId
    const northstarClientId = 'c0000000-0000-4000-8000-000000000002';
    const mismatchInput = {
      ...validModelInput,
      parameters: {
        ...validModelInput.parameters,
        clientId: northstarClientId,
        projectId: validProjectId, // Belongs to Acme Labs, not Northstar
      },
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: mismatchInput,
        correlationId: 'req-corr-007',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/belongs to client/);
  });

  it('8. target project updated_at precondition derived server-side', async () => {
    const env = setupTestEnvironment();

    const registered = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-008',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    const project = await env.mockData.projectRepository.findById(
      tenant,
      validProjectId,
    );
    expect(project).not.toBeNull();

    expect(registered.preconditions).toHaveLength(1);
    expect(registered.preconditions[0]).toEqual({
      entityType: 'project',
      entityId: validProjectId,
      versionField: 'updated_at',
      expectedValue: project!.updatedAt,
    });
  });

  it('9. hashes derived server-side strictly', async () => {
    const env = setupTestEnvironment();

    const registered = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-009',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(registered.parameterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registered.approvalBindingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('10. caller-supplied trusted fields rejected', async () => {
    const env = setupTestEnvironment();

    const hostileInput = {
      ...validModelInput,
      organizationId: 'malicious-org-id',
      status: 'APPROVED',
      parameterHash: 'fake-hash',
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: hostileInput,
        correlationId: 'req-corr-010',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow();
  });

  it('11. transaction rollback leaves no partial proposal/audit events', async () => {
    const env = setupTestEnvironment();

    // Custom transaction runner that simulates a failure and rollback
    const simulatedTxState: { rolledBack: boolean } = { rolledBack: false };
    const mockTxRunner = async <T>(
      fn: (txOptions: RepositoryTransactionOptions) => Promise<T>,
    ): Promise<T> => {
      try {
        return await fn({ client: { query: async () => ({ rows: [] }) } });
      } catch (err) {
        simulatedTxState.rolledBack = true;
        throw err;
      }
    };

    // Force failure during status transition by pointing to a mock repository that throws
    const throwingProposalRepo = Object.assign(
      Object.create(env.actionProposalRepo),
      {
        transitionStatus: async () => {
          throw new Error('Simulated database deadlock during transition');
        },
      },
    );

    await expect(
      registerActionProposal({
        tenant,
        modelInput: validModelInput,
        correlationId: 'req-corr-011',
        evidenceResolver,
        repositories: {
          ...env.repositories,
          actionProposalRepository:
            throwingProposalRepo as unknown as MockActionProposalRepository,
        },
        clock: fixedClock,
        transactionRunner: mockTxRunner,
      }),
    ).rejects.toThrow('Simulated database deadlock during transition');

    expect(simulatedTxState.rolledBack).toBe(true);
  });

  it('12. missing transactionRunner throws ProposalRegistrationError fail-closed', async () => {
    const env = setupTestEnvironment();

    await expect(
      registerActionProposal({
        tenant,
        modelInput: validModelInput,
        correlationId: 'req-corr-012',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: undefined as unknown as TransactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow(/mandatory TransactionRunner must be provided/);
  });

  it('13. invalid ttlMs (zero, negative, NaN, non-finite, excessive) rejected fail-closed', async () => {
    const env = setupTestEnvironment();

    for (const invalidTtl of [
      0,
      -1000,
      NaN,
      Infinity,
      -Infinity,
      31 * 24 * 60 * 60 * 1000,
    ]) {
      await expect(
        registerActionProposal({
          tenant,
          modelInput: validModelInput,
          correlationId: 'req-corr-013',
          evidenceResolver,
          repositories: env.repositories,
          transactionRunner: env.transactionRunner,
          clock: fixedClock,
          ttlMs: invalidTtl,
        }),
      ).rejects.toThrow(ProposalRegistrationError);
    }
  });

  it('14. valid bounded ttlMs derives accurate expiration timestamp', async () => {
    const env = setupTestEnvironment();
    const customTtlMs = 2 * 60 * 60 * 1000; // 2 hours

    const registered = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-014',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
      ttlMs: customTtlMs,
    });

    expect(registered.expiresAt).toBe(
      new Date(fixedClock.now().getTime() + customTtlMs).toISOString(),
    );
  });

  it('15. throws USER_REPOSITORY_REQUIRED if assigneeUserId provided without userRepository', async () => {
    const env = setupTestEnvironment();
    const reposWithoutUsers = {
      ...env.repositories,
      userRepository:
        undefined as unknown as typeof env.repositories.userRepository,
    };

    const inputWithAssignee = {
      ...validModelInput,
      parameters: {
        ...validModelInput.parameters,
        assigneeUserId: '10000000-0000-4000-8000-000000000011',
      },
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: inputWithAssignee,
        correlationId: 'req-corr-015',
        evidenceResolver,
        repositories: reposWithoutUsers,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow('UserRepository is required');
  });

  it('16. throws MILESTONE_REPOSITORY_REQUIRED if milestoneId provided without milestoneRepository', async () => {
    const env = setupTestEnvironment();
    const reposWithoutMilestones = {
      ...env.repositories,
      milestoneRepository:
        undefined as unknown as typeof env.repositories.milestoneRepository,
    };

    const inputWithMilestone = {
      ...validModelInput,
      parameters: {
        ...validModelInput.parameters,
        milestoneId: 'b0000000-0000-4000-8000-000000000001',
      },
    };

    await expect(
      registerActionProposal({
        tenant,
        modelInput: inputWithMilestone,
        correlationId: 'req-corr-016',
        evidenceResolver,
        repositories: reposWithoutMilestones,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toThrow('MilestoneRepository is required');
  });

  it('17. replaying the same trusted correlation returns the same proposal without duplicate audit events', async () => {
    const env = setupTestEnvironment();

    const first = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-idempotent',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    const replay = await registerActionProposal({
      tenant,
      modelInput: {
        ...validModelInput,
        parameters: {
          ...validModelInput.parameters,
          title: 'This replay input must not create a second proposal',
        },
      },
      correlationId: 'req-corr-idempotent',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('PENDING_APPROVAL');
    expect(env.actionProposalRepo.proposals.size).toBe(1);
    expect(env.auditEventRepo.getEvents()).toHaveLength(2);
  });

  it('18. empty trusted correlationId is rejected before proposal work', async () => {
    const env = setupTestEnvironment();

    await expect(
      registerActionProposal({
        tenant,
        modelInput: validModelInput,
        correlationId: '   ',
        evidenceResolver,
        repositories: env.repositories,
        transactionRunner: env.transactionRunner,
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CORRELATION_ID',
    });

    expect(env.actionProposalRepo.proposals.size).toBe(0);
    expect(env.auditEventRepo.getEvents()).toHaveLength(0);
  });

  it('19. unique-key race is reconciled to the winning proposal after rollback', async () => {
    const env = setupTestEnvironment();

    const winning = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-race-winner',
      evidenceResolver,
      repositories: env.repositories,
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    let lookupCount = 0;
    const racingRepo = {
      ...env.actionProposalRepo,
      findByCorrelationId: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? null : winning;
      },
      create: async () => {
        const error = Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_action_proposals_org_correlation',
        });
        throw error;
      },
      transitionStatus: env.actionProposalRepo.transitionStatus.bind(
        env.actionProposalRepo,
      ),
      findById: env.actionProposalRepo.findById.bind(env.actionProposalRepo),
      listPending: env.actionProposalRepo.listPending.bind(
        env.actionProposalRepo,
      ),
    };

    const replay = await registerActionProposal({
      tenant,
      modelInput: validModelInput,
      correlationId: 'req-corr-race-winner',
      evidenceResolver,
      repositories: {
        ...env.repositories,
        actionProposalRepository: racingRepo,
      },
      transactionRunner: env.transactionRunner,
      clock: fixedClock,
    });

    expect(replay.id).toBe(winning.id);
    expect(lookupCount).toBe(2);
  });
});
