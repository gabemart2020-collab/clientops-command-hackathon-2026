import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDatabasePool,
  closeDatabasePool,
  runMigrations,
  runSeed,
  createPostgresDataStore,
  PostgresActionProposalRepository,
  PostgresAuditEventRepository,
} from '@clientops/data';
import {
  DEMO_ORGANIZATION_ID,
  createTenantContext,
  FixedClock,
  type Clock,
  type DbClient,
  type TenantContext,
  type CreateControlledTaskParams,
  type RepositoryTransactionOptions,
} from '@clientops/domain';
import {
  registerActionProposal,
  executeApprovedAction,
  resolveApprovalDecision,
  PreconditionFailedError,
  UnauthorizedApproverError,
  type AuthoritativeEvidenceResolver,
  type TransactionRunner,
} from '@clientops/policy';
import type {
  ModelActionProposalInput,
  AuditEvent,
} from '@clientops/contracts';
import { GET as inspectRoute } from './app/api/actions/[proposalId]/route.js';
import { POST as decisionRoute } from './app/api/actions/[proposalId]/decision/route.js';
import {
  getActionServerContext,
  setActionServerContextForTesting,
  ActionStoreUnavailableError,
} from './lib/action-context.js';

describe('Phase 4.2 End-to-End PostgreSQL Action Approval Lifecycle', () => {
  type PoolType = ReturnType<typeof getDatabasePool>;
  let pool: PoolType;
  const originalEnv = { ...process.env };
  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);

  const ACME_CLIENT_ID = 'c0000000-0000-4000-8000-000000000001';
  const ACME_PROJECT_ID = 'a0000000-0000-4000-8000-000000000001';
  const CANONICAL_OPERATOR_ID = '10000000-0000-4000-8000-000000000011';
  const SEEDED_MEETING_ID = 'e0000000-0000-4000-8000-000000000002';
  const SEEDED_COMMITMENT_ID = 'c1000000-0000-4000-8000-000000000001';

  const validSameOriginHeaders = {
    'Content-Type': 'application/json',
    'sec-fetch-site': 'same-origin',
    origin: 'http://localhost:3000',
  };

  const authoritativeEvidenceResolver: AuthoritativeEvidenceResolver = {
    resolveCitation: (citation) => {
      if (
        citation.entityType === 'meeting' &&
        citation.entityId === SEEDED_MEETING_ID
      ) {
        return {
          success: true,
          resolved: {
            entityType: 'meeting',
            entityId: SEEDED_MEETING_ID,
            field: 'summary',
            excerpt:
              'Reviewed migration architecture and agreed on cutover schedule.',
          },
        };
      }
      if (
        citation.entityType === 'commitment' &&
        citation.entityId === SEEDED_COMMITMENT_ID
      ) {
        return {
          success: true,
          resolved: {
            entityType: 'commitment',
            entityId: SEEDED_COMMITMENT_ID,
            field: 'description',
            excerpt: 'Deliver revised schema documentation',
          },
        };
      }
      return {
        success: false,
        error: `Unknown citation ${citation.entityType}:${citation.entityId}`,
      };
    },
  };

  beforeAll(async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV =
      'development';
    process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = 'true';
    process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED = 'true';

    // Clear any mock test context so routes use genuine PostgreSQL backing store
    setActionServerContextForTesting(null);

    pool = getDatabasePool();
    await runMigrations(pool);
    await runSeed(pool);
  });

  afterAll(async () => {
    setActionServerContextForTesting(null);
    await closeDatabasePool();
    (process.env as Record<string, string | undefined>).NODE_ENV =
      originalEnv.NODE_ENV;
    delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;
    if (originalEnv.CLIENTOPS_WEB_ACTION_WRITES_ENABLED === undefined) {
      delete process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
    } else {
      process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED =
        originalEnv.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
    }
  });

  it('demonstrates full Phase 4.2 APPROVE lifecycle end-to-end against PostgreSQL', async () => {
    // 0. Record initial task count in PostgreSQL
    const initialTasksRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE organization_id = $1',
      [tenant.organizationId],
    );
    const initialTaskCount = initialTasksRes.rows[0].count;

    // 1. Authoritative repositories and transaction runner backed by PostgreSQL
    const dataStore = createPostgresDataStore(pool);
    const actionProposalRepo = new PostgresActionProposalRepository(pool);
    const auditEventRepo = new PostgresAuditEventRepository(pool);

    const transactionRunner: TransactionRunner = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn({ client: client as unknown as DbClient });
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    // 2. Grounded model proposal input with citations to seeded Acme Labs entities
    const groundedModelInput: ModelActionProposalInput = {
      actionType: 'task.create',
      parameters: {
        clientId: ACME_CLIENT_ID,
        projectId: ACME_PROJECT_ID,
        title: 'Execute final cutover migration dry-run',
        description:
          'Run staged dry-run to validate dual-write buffer and telemetry forwarder.',
        priority: 'high',
      },
      justification:
        'Proposal justified by cutover rehearsal commitment and agreed migration schedule.',
      citations: [
        {
          entityType: 'meeting',
          entityId: SEEDED_MEETING_ID,
          field: 'summary',
        },
        {
          entityType: 'commitment',
          entityId: SEEDED_COMMITMENT_ID,
          field: 'description',
        },
      ],
    };

    // 3. Atomic proposal registration in PENDING_APPROVAL
    const correlationId = 'test-corr-approve-lifecycle-1';
    const pendingProposal = await registerActionProposal({
      tenant,
      modelInput: groundedModelInput,
      correlationId,
      evidenceResolver: authoritativeEvidenceResolver,
      repositories: {
        clientRepository: dataStore.clients,
        projectRepository: dataStore.projects,
        actionProposalRepository: actionProposalRepo,
        auditEventRepository: auditEventRepo,
        userRepository: dataStore.users,
        milestoneRepository: dataStore.milestones,
      },
      transactionRunner,
    });

    expect(pendingProposal.id).toBeDefined();
    expect(pendingProposal.status).toBe('PENDING_APPROVAL');
    expect(pendingProposal.organizationId).toBe(tenant.organizationId);

    // Verify initial database state: 1 proposal, 0 approvals, 0 executions, 0 new tasks
    const dbProposalInitial = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1 AND organization_id = $2',
      [pendingProposal.id, tenant.organizationId],
    );
    expect(dbProposalInitial.rows[0].status).toBe('PENDING_APPROVAL');

    const dbAuditInitial = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 ORDER BY occurred_at ASC',
      [pendingProposal.id],
    );
    expect(
      dbAuditInitial.rows.map((r: { event_type: string }) => r.event_type),
    ).toEqual(['ACTION_PROPOSED', 'APPROVAL_REQUESTED']);

    // 4. Review inspection endpoint returns accurate masked/sanitized context
    const inspectReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}`,
      { method: 'GET' },
    );
    const inspectRes = await inspectRoute(inspectReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(inspectRes.status).toBe(200);

    const inspectBody = await inspectRes.json();
    expect(inspectBody.success).toBe(true);
    expect(inspectBody.data.id).toBe(pendingProposal.id);
    expect(inspectBody.data.status).toBe('PENDING_APPROVAL');
    expect(inspectBody.data.client.id).toBe(ACME_CLIENT_ID);
    expect(inspectBody.data.client.name).toBe('Acme Labs');
    expect(inspectBody.data.project.id).toBe(ACME_PROJECT_ID);
    expect(inspectBody.data.project.name).toBe('Cloud Analytics Migration');
    expect(inspectBody.data.task.title).toBe(
      'Execute final cutover migration dry-run',
    );
    expect(inspectBody.data.evidence).toHaveLength(2);
    // Ensure security-critical internal hashes are omitted
    expect(inspectBody.data.parameterHash).toBeUndefined();
    expect(inspectBody.data.approvalBindingHash).toBeUndefined();

    // 5. Successful POST APPROVE through the decision route
    const decisionReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'APPROVE',
          comment:
            'Grounded in cutover schedule and schema documentation commitment.',
        }),
      },
    );
    const decisionRes = await decisionRoute(decisionReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(decisionRes.status).toBe(200);

    const decisionBody = await decisionRes.json();
    expect(decisionBody.success).toBe(true);
    expect(decisionBody.data.decision).toBe('APPROVE');
    expect(decisionBody.data.status).toBe('COMPLETED');
    expect(decisionBody.data.proposalId).toBe(pendingProposal.id);
    expect(decisionBody.data.execution.status).toBe('COMPLETED');
    expect(decisionBody.data.execution.task).toBeDefined();
    expect(decisionBody.data.execution.task.title).toBe(
      pendingProposal.parameters.title,
    );

    // 6. Verify durable PostgreSQL state:
    // a. Proposal status is COMPLETED
    const dbProposalFinal = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1 AND organization_id = $2',
      [pendingProposal.id, tenant.organizationId],
    );
    expect(dbProposalFinal.rows[0].status).toBe('COMPLETED');

    // b. Exactly one action_approvals row exists with decision APPROVE
    const dbApprovals = await pool.query(
      'SELECT id, decision, actor_id, actor_role, comment FROM action_approvals WHERE action_proposal_id = $1 AND organization_id = $2',
      [pendingProposal.id, tenant.organizationId],
    );
    expect(dbApprovals.rows).toHaveLength(1);
    expect(dbApprovals.rows[0].decision).toBe('APPROVE');
    expect(dbApprovals.rows[0].actor_id).toBe(CANONICAL_OPERATOR_ID);
    expect(dbApprovals.rows[0].actor_role).toBe('operator');
    expect(dbApprovals.rows[0].comment).toBe(
      'Grounded in cutover schedule and schema documentation commitment.',
    );

    // c. Exactly one ACTION_APPROVED audit event exists
    const dbAuditApproved = await pool.query(
      "SELECT event_type, actor_id, payload->>'actorRole' AS actor_role FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2",
      [pendingProposal.id, 'ACTION_APPROVED'],
    );
    expect(dbAuditApproved.rows).toHaveLength(1);
    expect(dbAuditApproved.rows[0].actor_id).toBe(CANONICAL_OPERATOR_ID);
    expect(dbAuditApproved.rows[0].actor_role).toBe('operator');

    // d. Exactly one action_executions row in COMPLETED status
    const dbExecutions = await pool.query(
      'SELECT id, status, target_entity_id, executor_principal FROM action_executions WHERE action_proposal_id = $1',
      [pendingProposal.id],
    );
    expect(dbExecutions.rows).toHaveLength(1);
    expect(dbExecutions.rows[0].status).toBe('COMPLETED');
    expect(dbExecutions.rows[0].executor_principal).toBe(
      'clientops_trusted_executor',
    );
    const createdTaskId = dbExecutions.rows[0].target_entity_id;
    expect(createdTaskId).toBe(decisionBody.data.execution.task.id);

    // e. Exactly one new task created with durable business fields and source provenance
    const finalTasksRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE organization_id = $1',
      [tenant.organizationId],
    );
    expect(finalTasksRes.rows[0].count).toBe(initialTaskCount + 1);

    const dbTaskRes = await pool.query(
      'SELECT id, title, description, priority, status, source_action_proposal_id FROM tasks WHERE id = $1 AND organization_id = $2',
      [createdTaskId, tenant.organizationId],
    );
    expect(dbTaskRes.rows).toHaveLength(1);
    expect(dbTaskRes.rows[0].title).toBe(pendingProposal.parameters.title);
    expect(dbTaskRes.rows[0].priority).toBe('high');
    expect(dbTaskRes.rows[0].status).toBe('open');
    expect(dbTaskRes.rows[0].source_action_proposal_id).toBe(
      pendingProposal.id,
    );

    // f. Audit events sequence: ACTION_PROPOSED, APPROVAL_REQUESTED, ACTION_APPROVED, EXECUTION_STARTED, EXECUTION_COMPLETED
    const dbAuditAll = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 ORDER BY occurred_at ASC',
      [pendingProposal.id],
    );
    expect(
      dbAuditAll.rows.map((r: { event_type: string }) => r.event_type),
    ).toEqual([
      'ACTION_PROPOSED',
      'APPROVAL_REQUESTED',
      'ACTION_APPROVED',
      'EXECUTION_STARTED',
      'EXECUTION_COMPLETED',
    ]);

    // 7. Idempotent retry: POST decision APPROVE again returns same task and COMPLETED status without duplicate mutation
    const retryReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sec-fetch-site': 'same-origin',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({
          decision: 'APPROVE',
        }),
      },
    );
    const retryRes = await decisionRoute(retryReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.success).toBe(true);
    expect(retryBody.data.status).toBe('COMPLETED');
    expect(retryBody.data.idempotent).toBe(true);
    expect(retryBody.data.execution.task.id).toBe(createdTaskId);

    // Task count still strictly initialTaskCount + 1
    const postRetryTasksRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE organization_id = $1',
      [tenant.organizationId],
    );
    expect(postRetryTasksRes.rows[0].count).toBe(initialTaskCount + 1);
  });

  it('demonstrates full Phase 4.2 DENY lifecycle end-to-end against PostgreSQL', async () => {
    // 0. Record initial task count in PostgreSQL
    const initialTasksRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE organization_id = $1',
      [tenant.organizationId],
    );
    const initialTaskCount = initialTasksRes.rows[0].count;

    // 1. Authoritative repositories and transaction runner backed by PostgreSQL
    const dataStore = createPostgresDataStore(pool);
    const actionProposalRepo = new PostgresActionProposalRepository(pool);
    const auditEventRepo = new PostgresAuditEventRepository(pool);

    const transactionRunner: TransactionRunner = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn({ client: client as unknown as DbClient });
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    // 2. Second grounded proposal input
    const secondModelInput: ModelActionProposalInput = {
      actionType: 'task.create',
      parameters: {
        clientId: ACME_CLIENT_ID,
        projectId: ACME_PROJECT_ID,
        title: 'Legacy ETL manual data backfill',
        description:
          'Attempt manual backfill of deprecated staging tables before cutover.',
        priority: 'low',
      },
      justification:
        'Proposal justified by legacy meeting note referencing cutover schedule.',
      citations: [
        {
          entityType: 'meeting',
          entityId: SEEDED_MEETING_ID,
          field: 'summary',
        },
      ],
    };

    // 3. Atomic proposal registration in PENDING_APPROVAL
    const correlationId = 'test-corr-deny-lifecycle-2';
    const pendingProposal = await registerActionProposal({
      tenant,
      modelInput: secondModelInput,
      correlationId,
      evidenceResolver: authoritativeEvidenceResolver,
      repositories: {
        clientRepository: dataStore.clients,
        projectRepository: dataStore.projects,
        actionProposalRepository: actionProposalRepo,
        auditEventRepository: auditEventRepo,
        userRepository: dataStore.users,
        milestoneRepository: dataStore.milestones,
      },
      transactionRunner,
    });

    expect(pendingProposal.id).toBeDefined();
    expect(pendingProposal.status).toBe('PENDING_APPROVAL');

    // 4. Decision route call with DENY
    const denyReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'DENY',
          comment:
            'Manual backfill of deprecated staging tables is unapproved and obsolete.',
        }),
      },
    );
    const denyRes = await decisionRoute(denyReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(denyRes.status).toBe(200);

    const denyBody = await denyRes.json();
    expect(denyBody.success).toBe(true);
    expect(denyBody.data.decision).toBe('DENY');
    expect(denyBody.data.status).toBe('DENIED');
    expect(denyBody.data.proposalId).toBe(pendingProposal.id);

    // 5. Verify durable PostgreSQL state:
    // a. Proposal status is DENIED
    const dbProposalFinal = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1 AND organization_id = $2',
      [pendingProposal.id, tenant.organizationId],
    );
    expect(dbProposalFinal.rows[0].status).toBe('DENIED');

    // b. Exactly one action_approvals row exists with decision DENY
    const dbApprovals = await pool.query(
      'SELECT id, decision, actor_id, actor_role, comment FROM action_approvals WHERE action_proposal_id = $1 AND organization_id = $2',
      [pendingProposal.id, tenant.organizationId],
    );
    expect(dbApprovals.rows).toHaveLength(1);
    expect(dbApprovals.rows[0].decision).toBe('DENY');
    expect(dbApprovals.rows[0].actor_id).toBe(CANONICAL_OPERATOR_ID);
    expect(dbApprovals.rows[0].actor_role).toBe('operator');
    expect(dbApprovals.rows[0].comment).toBe(
      'Manual backfill of deprecated staging tables is unapproved and obsolete.',
    );

    // c. Exactly one ACTION_DENIED audit event exists
    const dbAuditDenied = await pool.query(
      "SELECT event_type, actor_id, payload->>'actorRole' AS actor_role FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2",
      [pendingProposal.id, 'ACTION_DENIED'],
    );
    expect(dbAuditDenied.rows).toHaveLength(1);
    expect(dbAuditDenied.rows[0].actor_id).toBe(CANONICAL_OPERATOR_ID);
    expect(dbAuditDenied.rows[0].actor_role).toBe('operator');

    // Sequence of audit events for this denied proposal: ACTION_PROPOSED, APPROVAL_REQUESTED, ACTION_DENIED
    const dbAuditAll = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 ORDER BY occurred_at ASC',
      [pendingProposal.id],
    );
    expect(
      dbAuditAll.rows.map((r: { event_type: string }) => r.event_type),
    ).toEqual(['ACTION_PROPOSED', 'APPROVAL_REQUESTED', 'ACTION_DENIED']);

    // d. Zero action_executions rows
    const dbExecutions = await pool.query(
      'SELECT COUNT(*)::int AS count FROM action_executions WHERE action_proposal_id = $1',
      [pendingProposal.id],
    );
    expect(dbExecutions.rows[0].count).toBe(0);

    // e. Zero new task rows
    const finalTasksRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE organization_id = $1',
      [tenant.organizationId],
    );
    expect(finalTasksRes.rows[0].count).toBe(initialTaskCount);
  });

  it('store outage semantics: normalizes pool.connect() acquisition failures into ActionStoreUnavailableError without masking domain constraint/invariant errors', async () => {
    setActionServerContextForTesting(null);
    const serverCtx = getActionServerContext();

    // 1. Verify connection acquisition failure normalizes to ActionStoreUnavailableError
    const originalConnect = pool.connect;
    try {
      pool.connect = (async () => {
        throw new Error('Connection acquisition timed out (pool exhausted)');
      }) as unknown as typeof pool.connect;

      await expect(
        serverCtx.transactionRunner(async () => {
          return 'should-not-reach';
        }),
      ).rejects.toThrow(ActionStoreUnavailableError);
    } finally {
      pool.connect = originalConnect;
    }

    // 2. Verify domain constraint/invariant error thrown inside fn is re-thrown as-is (NOT masked)
    class CustomDomainInvariantError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomDomainInvariantError';
      }
    }

    await expect(
      serverCtx.transactionRunner(async () => {
        throw new CustomDomainInvariantError(
          'Specific domain invariant violated: invalid status transition',
        );
      }),
    ).rejects.toThrow(CustomDomainInvariantError);
  });

  // ==========================================================================
  // PHASE 4.3.1 TRANSACTION & RECONCILIATION HARDENING TESTS
  // ==========================================================================
  async function createApprovedProposalInDb(overrides?: {
    creationClock?: Clock;
    approvalClock?: Clock;
    validUntil?: string;
    assigneeUserId?: string;
    milestoneId?: string;
  }) {
    const actionCtx = getActionServerContext();
    const proposalInput: ModelActionProposalInput = {
      actionType: 'task.create',
      parameters: {
        clientId: ACME_CLIENT_ID,
        projectId: ACME_PROJECT_ID,
        title: 'PostgreSQL Controlled Execution Task',
        description: 'Testing transaction-bound execution and error handling',
        priority: 'high',
        assigneeUserId: overrides?.assigneeUserId ?? CANONICAL_OPERATOR_ID,
        milestoneId:
          overrides?.milestoneId ?? 'b0000000-0000-4000-8000-000000000001',
        dueAt: '2026-10-25T12:00:00.000Z',
      },
      justification: 'Automated test recovery operation',
      citations: [
        {
          entityType: 'meeting',
          entityId: SEEDED_MEETING_ID,
          field: 'summary',
        },
      ],
    };

    const registered = await registerActionProposal({
      tenant,
      modelInput: proposalInput,
      correlationId: `corr-${Date.now()}`,
      evidenceResolver: authoritativeEvidenceResolver,
      repositories: {
        clientRepository: actionCtx.dataStore.clients,
        projectRepository: actionCtx.dataStore.projects,
        userRepository: actionCtx.dataStore.users,
        milestoneRepository: actionCtx.dataStore.milestones,
        actionProposalRepository: actionCtx.actionProposalRepository,
        auditEventRepository: actionCtx.auditEventRepository,
      },
      transactionRunner: actionCtx.transactionRunner,
      clock:
        overrides?.creationClock ?? new FixedClock('2026-10-15T10:00:00.000Z'),
    });

    const approveResult = await resolveApprovalDecision({
      tenant,
      proposalId: registered.id,
      request: {
        decision: 'APPROVE',
        comment: 'Approved for test execution',
      },
      actor: {
        actorId: CANONICAL_OPERATOR_ID,
        role: 'operator',
        organizationId: tenant.organizationId,
        source: 'local_demo_adapter',
        isProductionActor: false,
      },
      repositories: {
        actionProposalRepository: actionCtx.actionProposalRepository,
        actionApprovalRepository: actionCtx.actionApprovalRepository,
        auditEventRepository: actionCtx.auditEventRepository,
        userRepository: actionCtx.dataStore.users,
        clientRepository: actionCtx.dataStore.clients,
        projectRepository: actionCtx.dataStore.projects,
      },
      transactionRunner: actionCtx.transactionRunner,
      clock:
        overrides?.approvalClock ?? new FixedClock('2026-10-15T11:00:00.000Z'),
    });

    if (overrides?.validUntil) {
      await pool.query(
        'UPDATE action_approvals SET valid_until = $1 WHERE action_proposal_id = $2',
        [overrides.validUntil, registered.id],
      );
    }

    return {
      proposalId: registered.id,
      proposal: approveResult.proposal,
      approval: approveResult.approval,
    };
  }

  it('SAVEPOINT failure: rolls back subtransaction on task error, commits FAILED execution and audit, 0 tasks', async () => {
    const { proposalId } = await createApprovedProposalInDb();
    const actionCtx = getActionServerContext();

    const failingTaskRepo = {
      createControlledTask: async (
        t: TenantContext,
        params: CreateControlledTaskParams,
        txOpts?: RepositoryTransactionOptions,
      ) => {
        // Intentionally fire an invalid SQL query on the transactional client to fail the subtransaction
        const client = txOpts?.client as {
          query: (sql: string) => Promise<unknown>;
        };
        await client.query('INSERT INTO non_existent_table (id) VALUES (1)');
        return actionCtx.controlledTaskMutationRepository.createControlledTask(
          t,
          params,
          txOpts,
        );
      },
      findById: (
        t: TenantContext,
        id: string,
        txOpts?: RepositoryTransactionOptions,
      ) => actionCtx.controlledTaskMutationRepository.findById(t, id, txOpts),
      findBySourceProposalId: (
        t: TenantContext,
        id: string,
        txOpts?: RepositoryTransactionOptions,
      ) =>
        actionCtx.controlledTaskMutationRepository.findBySourceProposalId(
          t,
          id,
          txOpts,
        ),
    };

    const result = await executeApprovedAction({
      tenant,
      proposalId,
      repositories: {
        actionProposalRepository: actionCtx.actionProposalRepository,
        actionApprovalRepository: actionCtx.actionApprovalRepository,
        actionExecutionRepository: actionCtx.actionExecutionRepository,
        auditEventRepository: actionCtx.auditEventRepository,
        controlledTaskMutationRepository: failingTaskRepo,
        userRepository: actionCtx.dataStore.users,
        projectRepository: actionCtx.dataStore.projects,
        milestoneRepository: actionCtx.dataStore.milestones,
      },
      transactionRunner: actionCtx.transactionRunner,
      clock: new FixedClock('2026-10-15T12:00:00.000Z'),
    });

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') throw new Error('Expected FAILED');
    expect(result.errorCode).toBe('TASK_CREATION_FAILED');
    expect(result.idempotent).toBe(false);

    // Verify durable PostgreSQL state:
    // a. Proposal status is FAILED
    const dbProp = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1',
      [proposalId],
    );
    expect(dbProp.rows[0].status).toBe('FAILED');

    // b. Execution record status is FAILED
    const dbExec = await pool.query(
      'SELECT status, error_code FROM action_executions WHERE action_proposal_id = $1',
      [proposalId],
    );
    expect(dbExec.rows[0].status).toBe('FAILED');
    expect(dbExec.rows[0].error_code).toBe('TASK_CREATION_FAILED');

    // c. Audit events contain EXECUTION_FAILED
    const dbAudit = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2',
      [proposalId, 'EXECUTION_FAILED'],
    );
    expect(dbAudit.rows).toHaveLength(1);

    // d. Zero tasks created for this proposal
    const dbTasks = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
      [proposalId],
    );
    expect(dbTasks.rows[0].count).toBe(0);
  });

  it('outer transaction rollback: rolls back completely on outer error, leaves proposal APPROVED without orphaned rows', async () => {
    const { proposalId } = await createApprovedProposalInDb();
    const actionCtx = getActionServerContext();

    const failingAuditRepo = {
      append: async (
        event: AuditEvent,
        txOpts?: RepositoryTransactionOptions,
      ) => {
        if (event.eventType === 'EXECUTION_STARTED') {
          throw new Error('Simulated outer transaction audit failure');
        }
        return actionCtx.auditEventRepository.append(event, txOpts);
      },
      listByProposalId: (
        t: TenantContext,
        id: string,
        txOpts?: RepositoryTransactionOptions,
      ) => actionCtx.auditEventRepository.listByProposalId(t, id, txOpts),
      listByCorrelationId: (
        t: TenantContext,
        correlationId: string,
        txOpts?: RepositoryTransactionOptions,
      ) =>
        actionCtx.auditEventRepository.listByCorrelationId(
          t,
          correlationId,
          txOpts,
        ),
    };

    await expect(
      executeApprovedAction({
        tenant,
        proposalId,
        repositories: {
          actionProposalRepository: actionCtx.actionProposalRepository,
          actionApprovalRepository: actionCtx.actionApprovalRepository,
          actionExecutionRepository: actionCtx.actionExecutionRepository,
          auditEventRepository: failingAuditRepo,
          controlledTaskMutationRepository:
            actionCtx.controlledTaskMutationRepository,
          userRepository: actionCtx.dataStore.users,
          projectRepository: actionCtx.dataStore.projects,
          milestoneRepository: actionCtx.dataStore.milestones,
        },
        transactionRunner: actionCtx.transactionRunner,
        clock: new FixedClock('2026-10-15T12:00:00.000Z'),
      }),
    ).rejects.toThrow('Simulated outer transaction audit failure');

    // Verify durable PostgreSQL state:
    // a. Proposal status is still APPROVED (rolled back from EXECUTING)
    const dbProp = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1',
      [proposalId],
    );
    expect(dbProp.rows[0].status).toBe('APPROVED');

    // b. Zero execution rows exist
    const dbExec = await pool.query(
      'SELECT COUNT(*)::int AS count FROM action_executions WHERE action_proposal_id = $1',
      [proposalId],
    );
    expect(dbExec.rows[0].count).toBe(0);

    // c. Zero task rows exist
    const dbTasks = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
      [proposalId],
    );
    expect(dbTasks.rows[0].count).toBe(0);
  });

  it('true post-mutation outer rollback: rolls back task mutation on post-task outer error, allows clean retry to create exactly one task', async () => {
    const { proposalId } = await createApprovedProposalInDb();
    const actionCtx = getActionServerContext();

    // Injected repository wrapper fails AFTER task mutation, while appending EXECUTION_COMPLETED
    const failingAuditRepo = {
      append: async (
        event: AuditEvent,
        txOpts?: RepositoryTransactionOptions,
      ) => {
        if (event.eventType === 'EXECUTION_COMPLETED') {
          throw new Error(
            'Simulated outer transaction post-task audit failure',
          );
        }
        return actionCtx.auditEventRepository.append(event, txOpts);
      },
      listByProposalId: (
        t: TenantContext,
        id: string,
        txOpts?: RepositoryTransactionOptions,
      ) => actionCtx.auditEventRepository.listByProposalId(t, id, txOpts),
      listByCorrelationId: (
        t: TenantContext,
        correlationId: string,
        txOpts?: RepositoryTransactionOptions,
      ) =>
        actionCtx.auditEventRepository.listByCorrelationId(
          t,
          correlationId,
          txOpts,
        ),
    };

    await expect(
      executeApprovedAction({
        tenant,
        proposalId,
        repositories: {
          actionProposalRepository: actionCtx.actionProposalRepository,
          actionApprovalRepository: actionCtx.actionApprovalRepository,
          actionExecutionRepository: actionCtx.actionExecutionRepository,
          auditEventRepository: failingAuditRepo,
          controlledTaskMutationRepository:
            actionCtx.controlledTaskMutationRepository,
          userRepository: actionCtx.dataStore.users,
          projectRepository: actionCtx.dataStore.projects,
          milestoneRepository: actionCtx.dataStore.milestones,
        },
        transactionRunner: actionCtx.transactionRunner,
        clock: new FixedClock('2026-10-15T12:00:00.000Z'),
      }),
    ).rejects.toThrow('Simulated outer transaction post-task audit failure');

    // Verify durable PostgreSQL state after post-mutation rollback:
    // a. Proposal status is still APPROVED
    const dbProp = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1',
      [proposalId],
    );
    expect(dbProp.rows[0].status).toBe('APPROVED');

    // b. Approval remains immutable APPROVE
    const dbAppr = await pool.query(
      'SELECT decision FROM action_approvals WHERE action_proposal_id = $1',
      [proposalId],
    );
    expect(dbAppr.rows).toHaveLength(1);
    expect(dbAppr.rows[0].decision).toBe('APPROVE');

    // c. action_executions count for proposal == 0
    const dbExec = await pool.query(
      'SELECT COUNT(*)::int AS count FROM action_executions WHERE action_proposal_id = $1',
      [proposalId],
    );
    expect(dbExec.rows[0].count).toBe(0);

    // d. tasks.source_action_proposal_id count == 0 (task rolled back completely)
    const dbTasks = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
      [proposalId],
    );
    expect(dbTasks.rows[0].count).toBe(0);

    // e. EXECUTION_STARTED count == 0
    const dbAuditStarted = await pool.query(
      'SELECT COUNT(*)::int AS count FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2',
      [proposalId, 'EXECUTION_STARTED'],
    );
    expect(dbAuditStarted.rows[0].count).toBe(0);

    // f. EXECUTION_COMPLETED count == 0
    const dbAuditCompleted = await pool.query(
      'SELECT COUNT(*)::int AS count FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2',
      [proposalId, 'EXECUTION_COMPLETED'],
    );
    expect(dbAuditCompleted.rows[0].count).toBe(0);

    // g. A later retry can execute normally and produces exactly one task
    const retryResult = await executeApprovedAction({
      tenant,
      proposalId,
      repositories: {
        actionProposalRepository: actionCtx.actionProposalRepository,
        actionApprovalRepository: actionCtx.actionApprovalRepository,
        actionExecutionRepository: actionCtx.actionExecutionRepository,
        auditEventRepository: actionCtx.auditEventRepository,
        controlledTaskMutationRepository:
          actionCtx.controlledTaskMutationRepository,
        userRepository: actionCtx.dataStore.users,
        projectRepository: actionCtx.dataStore.projects,
        milestoneRepository: actionCtx.dataStore.milestones,
      },
      transactionRunner: actionCtx.transactionRunner,
      clock: new FixedClock('2026-10-15T12:00:00.000Z'),
    });

    expect(retryResult.status).toBe('COMPLETED');
    expect(retryResult.idempotent).toBe(false);
    if (retryResult.status !== 'COMPLETED') {
      throw new Error('Expected COMPLETED');
    }

    // Assert durably exactly 1 task exists
    const dbFinalTasks = await pool.query(
      'SELECT id, title FROM tasks WHERE source_action_proposal_id = $1',
      [proposalId],
    );
    expect(dbFinalTasks.rows).toHaveLength(1);
    expect(dbFinalTasks.rows[0].id).toBe(retryResult.task.id);
  });

  it('durable expiration: commits EXPIRED status and ACTION_EXPIRED audit event without rolling back', async () => {
    // Registered on 2026-10-14 (expires 24h later on 2026-10-15T10:00:00Z)
    const { proposalId } = await createApprovedProposalInDb({
      creationClock: new FixedClock('2026-10-14T10:00:00.000Z'),
      approvalClock: new FixedClock('2026-10-14T11:00:00.000Z'),
    });
    const actionCtx = getActionServerContext();

    // Executed on 2026-10-15T12:00:00Z (2 hours after proposal expiration)
    const result = await executeApprovedAction({
      tenant,
      proposalId,
      repositories: {
        actionProposalRepository: actionCtx.actionProposalRepository,
        actionApprovalRepository: actionCtx.actionApprovalRepository,
        actionExecutionRepository: actionCtx.actionExecutionRepository,
        auditEventRepository: actionCtx.auditEventRepository,
        controlledTaskMutationRepository:
          actionCtx.controlledTaskMutationRepository,
        userRepository: actionCtx.dataStore.users,
        projectRepository: actionCtx.dataStore.projects,
        milestoneRepository: actionCtx.dataStore.milestones,
      },
      transactionRunner: actionCtx.transactionRunner,
      clock: new FixedClock('2026-10-15T12:00:00.000Z'),
    });

    expect(result.status).toBe('EXPIRED');
    if (result.status !== 'EXPIRED') throw new Error('Expected EXPIRED');
    expect(result.reason).toBe('PROPOSAL_EXPIRED');
    expect(result.idempotent).toBe(false);

    // Verify durable PostgreSQL state:
    // a. Proposal status is committed as EXPIRED
    const dbProp = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1',
      [proposalId],
    );
    expect(dbProp.rows[0].status).toBe('EXPIRED');

    // b. Exactly one ACTION_EXPIRED audit event committed
    const dbAudit = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 AND event_type = $2',
      [proposalId, 'ACTION_EXPIRED'],
    );
    expect(dbAudit.rows).toHaveLength(1);

    // c. Zero execution rows and zero task rows
    const dbExec = await pool.query(
      'SELECT COUNT(*)::int AS count FROM action_executions WHERE action_proposal_id = $1',
      [proposalId],
    );
    expect(dbExec.rows[0].count).toBe(0);

    const dbTasks = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
      [proposalId],
    );
    expect(dbTasks.rows[0].count).toBe(0);
  });

  it('concurrency rejection: rejects execution if approving user role was demoted prior to execution', async () => {
    const { proposalId } = await createApprovedProposalInDb();
    const actionCtx = getActionServerContext();

    // Demote operator Alice Walker to viewer in real PostgreSQL
    await pool.query("UPDATE users SET role = 'viewer' WHERE id = $1", [
      CANONICAL_OPERATOR_ID,
    ]);

    try {
      await expect(
        executeApprovedAction({
          tenant,
          proposalId,
          repositories: {
            actionProposalRepository: actionCtx.actionProposalRepository,
            actionApprovalRepository: actionCtx.actionApprovalRepository,
            actionExecutionRepository: actionCtx.actionExecutionRepository,
            auditEventRepository: actionCtx.auditEventRepository,
            controlledTaskMutationRepository:
              actionCtx.controlledTaskMutationRepository,
            userRepository: actionCtx.dataStore.users,
            projectRepository: actionCtx.dataStore.projects,
            milestoneRepository: actionCtx.dataStore.milestones,
          },
          transactionRunner: actionCtx.transactionRunner,
          clock: new FixedClock('2026-10-15T12:00:00.000Z'),
        }),
      ).rejects.toThrow(UnauthorizedApproverError);

      // Verify proposal remains APPROVED and no task created
      const dbProp = await pool.query(
        'SELECT status FROM action_proposals WHERE id = $1',
        [proposalId],
      );
      expect(dbProp.rows[0].status).toBe('APPROVED');

      const dbTasks = await pool.query(
        'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
        [proposalId],
      );
      expect(dbTasks.rows[0].count).toBe(0);
    } finally {
      // Restore Alice Walker to operator
      await pool.query("UPDATE users SET role = 'operator' WHERE id = $1", [
        CANONICAL_OPERATOR_ID,
      ]);
    }
  });

  it('milestone rejection: rejects execution if milestone belongs to another project', async () => {
    const { proposalId } = await createApprovedProposalInDb();
    const actionCtx = getActionServerContext();

    // Create a second project for test
    await pool.query(
      "INSERT INTO projects (id, organization_id, client_id, name, status, created_at, updated_at) VALUES ('a0000000-0000-4000-8000-000000000099', $1, $2, 'Other Project', 'active', NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
      [tenant.organizationId, ACME_CLIENT_ID],
    );

    // Concurrently move milestone to the other project in the database
    await pool.query(
      "UPDATE milestones SET project_id = 'a0000000-0000-4000-8000-000000000099' WHERE id = 'b0000000-0000-4000-8000-000000000001'",
    );

    try {
      await expect(
        executeApprovedAction({
          tenant,
          proposalId,
          repositories: {
            actionProposalRepository: actionCtx.actionProposalRepository,
            actionApprovalRepository: actionCtx.actionApprovalRepository,
            actionExecutionRepository: actionCtx.actionExecutionRepository,
            auditEventRepository: actionCtx.auditEventRepository,
            controlledTaskMutationRepository:
              actionCtx.controlledTaskMutationRepository,
            userRepository: actionCtx.dataStore.users,
            projectRepository: actionCtx.dataStore.projects,
            milestoneRepository: actionCtx.dataStore.milestones,
          },
          transactionRunner: actionCtx.transactionRunner,
          clock: new FixedClock('2026-10-15T12:00:00.000Z'),
        }),
      ).rejects.toThrow(PreconditionFailedError);
    } finally {
      // Restore milestone project_id
      await pool.query(
        "UPDATE milestones SET project_id = $1 WHERE id = 'b0000000-0000-4000-8000-000000000001'",
        [ACME_PROJECT_ID],
      );
    }
  });

  it('Phase 4.3.3 regression: live certification proposal shape with dueAt without milliseconds canonicalizes, executes, and passes readback', async () => {
    const actionCtx = getActionServerContext();

    // 1. Model input with ISO datetime lacking millisecond precision ('2026-10-16T09:00:00Z'), exactly as Bedrock emitted
    const rawDueAtWithoutMs = '2026-10-16T09:00:00Z';
    const canonicalDueAtWithMs = '2026-10-16T09:00:00.000Z';

    const groundedModelInput: ModelActionProposalInput = {
      actionType: 'task.create',
      parameters: {
        clientId: ACME_CLIENT_ID,
        projectId: ACME_PROJECT_ID,
        title: 'Review cutover monitoring and replica health',
        description:
          'Verify replica replication lag and telemetry forwarder status prior to cutover.',
        priority: 'high',
        assigneeUserId: CANONICAL_OPERATOR_ID,
        milestoneId: 'b0000000-0000-4000-8000-000000000001',
        dueAt: rawDueAtWithoutMs,
      },
      justification:
        'Required for real-time cutover verification per migration rehearsal schedule.',
      citations: [
        {
          entityType: 'meeting',
          entityId: SEEDED_MEETING_ID,
          field: 'summary',
        },
      ],
    };

    // 2. Register proposal through standard registration service
    const correlationId = `corr-dueat-canonicalization-${Date.now()}`;
    const pendingProposal = await registerActionProposal({
      tenant,
      modelInput: groundedModelInput,
      correlationId,
      evidenceResolver: authoritativeEvidenceResolver,
      repositories: {
        clientRepository: actionCtx.dataStore.clients,
        projectRepository: actionCtx.dataStore.projects,
        userRepository: actionCtx.dataStore.users,
        milestoneRepository: actionCtx.dataStore.milestones,
        actionProposalRepository: actionCtx.actionProposalRepository,
        auditEventRepository: actionCtx.auditEventRepository,
      },
      transactionRunner: actionCtx.transactionRunner,
    });

    expect(pendingProposal.id).toBeDefined();
    expect(pendingProposal.status).toBe('PENDING_APPROVAL');

    // Assert that the proposal parameters were canonicalized to .000Z
    expect(pendingProposal.parameters.dueAt).toBe(canonicalDueAtWithMs);

    // Verify durable PostgreSQL state for proposal row: parameters.dueAt is canonical .000Z
    const dbProposalRow = await pool.query(
      'SELECT parameters, parameter_hash, approval_binding_hash FROM action_proposals WHERE id = $1',
      [pendingProposal.id],
    );
    expect(dbProposalRow.rows[0].parameters.dueAt).toBe(canonicalDueAtWithMs);

    // 3. Approve via real decision route
    const decisionReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'APPROVE',
          comment: 'Approved for cutover monitoring.',
        }),
      },
    );
    const decisionRes = await decisionRoute(decisionReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(decisionRes.status).toBe(200);

    const decisionBody = await decisionRes.json();
    expect(decisionBody.success).toBe(true);
    expect(decisionBody.data.decision).toBe('APPROVE');
    expect(decisionBody.data.status).toBe('COMPLETED');
    expect(decisionBody.data.execution.status).toBe('COMPLETED');
    expect(decisionBody.data.execution.task).toBeDefined();
    const createdTaskId = decisionBody.data.execution.task.id;

    // 4. Assert durable PostgreSQL state:
    // a. Proposal status is COMPLETED
    const dbPropFinal = await pool.query(
      'SELECT status FROM action_proposals WHERE id = $1',
      [pendingProposal.id],
    );
    expect(dbPropFinal.rows[0].status).toBe('COMPLETED');

    // b. Exactly one task created with source_action_proposal_id matching proposal ID
    const dbTasks = await pool.query(
      'SELECT id, title, due_at, source_action_proposal_id FROM tasks WHERE source_action_proposal_id = $1',
      [pendingProposal.id],
    );
    expect(dbTasks.rows).toHaveLength(1);
    expect(dbTasks.rows[0].id).toBe(createdTaskId);
    expect(new Date(dbTasks.rows[0].due_at).toISOString()).toBe(
      canonicalDueAtWithMs,
    );

    // c. Exactly 5 audit events in correct sequence
    const dbAuditAll = await pool.query(
      'SELECT event_type FROM audit_events WHERE action_proposal_id = $1 ORDER BY occurred_at ASC',
      [pendingProposal.id],
    );
    expect(
      dbAuditAll.rows.map((r: { event_type: string }) => r.event_type),
    ).toEqual([
      'ACTION_PROPOSED',
      'APPROVAL_REQUESTED',
      'ACTION_APPROVED',
      'EXECUTION_STARTED',
      'EXECUTION_COMPLETED',
    ]);

    // 5. Assert idempotent retry with same task and 0 duplicate tasks
    const retryReq = new Request(
      `http://localhost:3000/api/actions/${pendingProposal.id}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'APPROVE',
        }),
      },
    );
    const retryRes = await decisionRoute(retryReq, {
      params: Promise.resolve({ proposalId: pendingProposal.id }),
    });
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.success).toBe(true);
    expect(retryBody.data.status).toBe('COMPLETED');
    expect(retryBody.data.idempotent).toBe(true);
    expect(retryBody.data.execution.task.id).toBe(createdTaskId);

    // Verify task count remains exactly 1 for this proposal (zero duplicates)
    const dbTasksAfterRetry = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tasks WHERE source_action_proposal_id = $1',
      [pendingProposal.id],
    );
    expect(dbTasksAfterRetry.rows[0].count).toBe(1);
  });
});
