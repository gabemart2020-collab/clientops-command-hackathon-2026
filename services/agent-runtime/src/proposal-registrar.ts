import {
  assertAgentProposerDatabasePrivileges,
  createPostgresDataStore,
  getDatabasePool,
  PostgresActionProposalRepository,
  PostgresAuditEventRepository,
} from '@clientops/data';
import { createTenantContext, type DbClient } from '@clientops/domain';
import {
  registerActionProposal,
  type TransactionRunner,
} from '@clientops/policy';
import type {
  ProposalRegistrar,
  ProposalRegistrationRequest,
  ProposalRegistrationResult,
} from './handler.js';

export class AgentProposerStoreUnavailableError extends Error {
  constructor(message = 'Agent proposer database store is unavailable.') {
    super(message);
    this.name = 'AgentProposerStoreUnavailableError';
  }
}

export async function createPostgresProposalRegistrar(): Promise<ProposalRegistrar> {
  const pool = getDatabasePool();

  await assertAgentProposerDatabasePrivileges(pool);

  const dataStore = createPostgresDataStore(pool);
  const actionProposalRepository = new PostgresActionProposalRepository(pool);
  const auditEventRepository = new PostgresAuditEventRepository(pool);

  const transactionRunner: TransactionRunner = async (fn) => {
    let client;
    try {
      client = await pool.connect();
    } catch {
      throw new AgentProposerStoreUnavailableError(
        'Failed to acquire proposer database connection from pool.',
      );
    }

    try {
      await client.query('BEGIN');
      const result = await fn({ client: client as unknown as DbClient });
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep rollback failures bounded; the original error remains authoritative.
      }
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async register(
      request: ProposalRegistrationRequest,
    ): Promise<ProposalRegistrationResult> {
      const tenant = createTenantContext(request.organizationId);
      const proposal = await registerActionProposal({
        tenant,
        modelInput: request.modelInput,
        correlationId: request.requestId,
        evidenceResolver: request.evidenceResolver,
        repositories: {
          clientRepository: dataStore.clients,
          projectRepository: dataStore.projects,
          actionProposalRepository,
          auditEventRepository,
          userRepository: dataStore.users,
          milestoneRepository: dataStore.milestones,
        },
        transactionRunner,
      });

      if (proposal.status !== 'PENDING_APPROVAL') {
        throw new AgentProposerStoreUnavailableError(
          'Proposal replay is no longer pending approval.',
        );
      }

      return {
        proposalId: proposal.id,
        status: 'PENDING_APPROVAL',
        reviewUrl: `/actions/${proposal.id}`,
      };
    },
  };
}
