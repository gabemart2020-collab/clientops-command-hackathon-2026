import {
  getDatabasePool,
  createPostgresDataStore,
  PostgresActionProposalRepository,
  PostgresActionApprovalRepository,
  PostgresActionExecutionRepository,
  PostgresControlledTaskMutationRepository,
  PostgresAuditEventRepository,
  InMemoryDataStore,
  InMemoryActionProposalRepository,
  InMemoryActionApprovalRepository,
  InMemoryActionExecutionRepository,
  InMemoryControlledTaskMutationRepository,
  InMemoryAuditEventRepository,
} from '@clientops/data';
import type {
  TenantContext,
  DbClient,
  DataRepositories,
  ActionProposalRepository,
  ActionApprovalRepository,
  ActionExecutionRepository,
  ControlledTaskMutationRepository,
  AuditEventRepository,
} from '@clientops/domain';
import { DEMO_ORGANIZATION_ID, createTenantContext } from '@clientops/domain';
import type { TransactionRunner } from '@clientops/policy';

export interface ActionServerContext {
  tenant: TenantContext;
  dataStore: DataRepositories;
  actionProposalRepository: ActionProposalRepository;
  actionApprovalRepository: ActionApprovalRepository;
  actionExecutionRepository: ActionExecutionRepository;
  controlledTaskMutationRepository: ControlledTaskMutationRepository;
  auditEventRepository: AuditEventRepository;
  transactionRunner: TransactionRunner;
}

export class ActionStoreUnavailableError extends Error {
  constructor(message = 'Durable action persistence store is unavailable.') {
    super(message);
    this.name = 'ActionStoreUnavailableError';
  }
}

let testActionServerContext:
  | ActionServerContext
  | (() => ActionServerContext)
  | null = null;

/**
 * Explicit test injector. Prohibited in production.
 */
export function setActionServerContextForTesting(
  ctx: ActionServerContext | (() => ActionServerContext) | null,
): void {
  testActionServerContext = ctx;
}

/**
 * Creates an in-memory ActionServerContext for offline unit testing only.
 */
export function createInMemoryActionServerContext(
  tenant: TenantContext = createTenantContext(DEMO_ORGANIZATION_ID),
): ActionServerContext {
  const dataStore = new InMemoryDataStore();
  const actionProposalRepository = new InMemoryActionProposalRepository();
  const actionApprovalRepository = new InMemoryActionApprovalRepository();
  const actionExecutionRepository = new InMemoryActionExecutionRepository();
  const controlledTaskMutationRepository =
    new InMemoryControlledTaskMutationRepository();
  const auditEventRepository = new InMemoryAuditEventRepository();
  const transactionRunner: TransactionRunner = async (fn) => fn({});

  return {
    tenant,
    dataStore,
    actionProposalRepository,
    actionApprovalRepository,
    actionExecutionRepository,
    controlledTaskMutationRepository,
    auditEventRepository,
    transactionRunner,
  };
}

export function getActionServerContext(): ActionServerContext {
  if (typeof testActionServerContext === 'function') {
    return testActionServerContext();
  }
  if (testActionServerContext) {
    return testActionServerContext;
  }

  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);

  try {
    const pool = getDatabasePool();
    const dataStore = createPostgresDataStore(pool);
    const actionProposalRepository = new PostgresActionProposalRepository(pool);
    const actionApprovalRepository = new PostgresActionApprovalRepository(pool);
    const actionExecutionRepository = new PostgresActionExecutionRepository(
      pool,
    );
    const controlledTaskMutationRepository =
      new PostgresControlledTaskMutationRepository(pool);
    const auditEventRepository = new PostgresAuditEventRepository(pool);

    const transactionRunner: TransactionRunner = async (fn) => {
      let client;
      try {
        client = await pool.connect();
      } catch {
        throw new ActionStoreUnavailableError(
          'Failed to acquire database connection from pool.',
        );
      }
      try {
        await client.query('BEGIN');
        const result = await fn({ client: client as unknown as DbClient });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback error on disconnected client
        }
        throw err;
      } finally {
        client.release();
      }
    };

    return {
      tenant,
      dataStore,
      actionProposalRepository,
      actionApprovalRepository,
      actionExecutionRepository,
      controlledTaskMutationRepository,
      auditEventRepository,
      transactionRunner,
    };
  } catch {
    throw new ActionStoreUnavailableError(
      'Durable action persistence store is unavailable.',
    );
  }
}
