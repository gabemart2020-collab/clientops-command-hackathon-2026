import { randomUUID } from 'node:crypto';
import {
  assertAgentProposerDatabasePrivileges,
  closeDatabasePool,
  getDatabasePool,
  readDatabaseSafetyConfig,
} from '../packages/data/src/index.js';
import type { DbClient } from '../packages/domain/src/index.js';

const CERTIFICATION_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const CERTIFICATION_PROJECT_ID = 'a0000000-0000-4000-8000-000000000001';

interface DenialProof {
  check: string;
  denied: boolean;
  errorCode?: string;
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

async function expectDenied(
  client: DbClient,
  name: string,
  sql: string,
  params: unknown[] = [],
): Promise<DenialProof> {
  const savepoint = `cert_${name.replace(/[^a-z0-9_]/gi, '_')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, params);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return { check: name, denied: false };
  } catch (error: unknown) {
    const errorCode = pgCode(error);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return { check: name, denied: true, ...(errorCode ? { errorCode } : {}) };
  }
}

async function main(): Promise<void> {
  const config = readDatabaseSafetyConfig();
  if (config.target !== 'staging' || config.workload !== 'agent-proposer') {
    throw new Error(
      'Staging Agent proposer certification requires CLIENTOPS_DATABASE_TARGET=staging and CLIENTOPS_DATABASE_WORKLOAD=agent-proposer.',
    );
  }

  const pool = getDatabasePool();
  const preflight = await assertAgentProposerDatabasePrivileges(pool);

  const proposalId = randomUUID();
  const duplicateProposalId = randomUUID();
  const correlationId = `phase5-2-cert-${randomUUID()}`;
  const parameterHash = '0'.repeat(64);
  const approvalBindingHash = '1'.repeat(64);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

  const client = await pool.connect();
  const certificationClient = client as unknown as DbClient;
  const denials: DenialProof[] = [];

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO public.action_proposals (
         id, organization_id, action_type, action_class, parameters,
         parameter_hash, approval_binding_hash, correlation_id, evidence,
         preconditions, status, justification, created_at, expires_at, updated_at
       ) VALUES (
         $1, $2, 'task.create', 'WRITE', $3::jsonb,
         $4, $5, $6, $7::jsonb,
         $8::jsonb, 'PROPOSED', $9, $10, $11, $10
       )`,
      [
        proposalId,
        CERTIFICATION_ORGANIZATION_ID,
        JSON.stringify({
          clientId: 'c0000000-0000-4000-8000-000000000001',
          projectId: CERTIFICATION_PROJECT_ID,
          title: 'Phase 5.2.2 rollback-safe proposer certification',
          priority: 'medium',
        }),
        parameterHash,
        approvalBindingHash,
        correlationId,
        JSON.stringify([
          {
            entityType: 'project',
            entityId: CERTIFICATION_PROJECT_ID,
            field: 'updated_at',
            excerpt: 'Phase 5.2.2 synthetic certification evidence',
          },
        ]),
        JSON.stringify([
          {
            entityType: 'project',
            entityId: CERTIFICATION_PROJECT_ID,
            versionField: 'updated_at',
            expectedValue: '2026-09-05T00:00:00.000Z',
          },
        ]),
        'Rollback-safe Phase 5.2.2 proposer privilege certification.',
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );

    await client.query(
      `INSERT INTO public.audit_events (
         id, organization_id, action_proposal_id, event_type, actor_id,
         parameter_hash, approval_binding_hash, correlation_id, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 'ACTION_PROPOSED', NULL,
         $4, $5, $6, $7::jsonb, $8
       )`,
      [
        randomUUID(),
        CERTIFICATION_ORGANIZATION_ID,
        proposalId,
        parameterHash,
        approvalBindingHash,
        correlationId,
        JSON.stringify({
          actionProposalId: proposalId,
          actionType: 'task.create',
          actionClass: 'WRITE',
          parameterHash,
          approvalBindingHash,
          justification:
            'Rollback-safe Phase 5.2.2 proposer privilege certification.',
          clientId: 'c0000000-0000-4000-8000-000000000001',
          projectId: CERTIFICATION_PROJECT_ID,
          preconditionCount: 1,
          citationCount: 1,
        }),
        now.toISOString(),
      ],
    );

    await client.query(
      `UPDATE public.action_proposals
       SET status = 'PENDING_APPROVAL', updated_at = now()
       WHERE id = $1
         AND organization_id = $2
         AND status = 'PROPOSED'`,
      [proposalId, CERTIFICATION_ORGANIZATION_ID],
    );

    await client.query(
      `INSERT INTO public.audit_events (
         id, organization_id, action_proposal_id, event_type, actor_id,
         parameter_hash, approval_binding_hash, correlation_id, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 'APPROVAL_REQUESTED', NULL,
         NULL, $4, $5, $6::jsonb, $7
       )`,
      [
        randomUUID(),
        CERTIFICATION_ORGANIZATION_ID,
        proposalId,
        approvalBindingHash,
        correlationId,
        JSON.stringify({
          actionProposalId: proposalId,
          requestedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          approvalBindingHash,
        }),
        now.toISOString(),
      ],
    );

    const allowed = await client.query<{ status: string }>(
      `SELECT status
       FROM public.action_proposals
       WHERE id = $1 AND organization_id = $2`,
      [proposalId, CERTIFICATION_ORGANIZATION_ID],
    );

    if (allowed.rows[0]?.status !== 'PENDING_APPROVAL') {
      throw new Error(
        'Agent proposer certification failed: allowed path did not reach PENDING_APPROVAL.',
      );
    }

    denials.push(
      await expectDenied(
        certificationClient,
        'later_proposal_transition',
        `UPDATE public.action_proposals
         SET status = 'APPROVED', updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [proposalId, CERTIFICATION_ORGANIZATION_ID],
      ),
    );

    denials.push(
      await expectDenied(
        certificationClient,
        'forbidden_audit_type',
        `INSERT INTO public.audit_events (
           id, organization_id, action_proposal_id, event_type, actor_id,
           approval_binding_hash, correlation_id, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 'ACTION_APPROVED', NULL,
           $4, $5, '{}'::jsonb, now()
         )`,
        [
          randomUUID(),
          CERTIFICATION_ORGANIZATION_ID,
          proposalId,
          approvalBindingHash,
          correlationId,
        ],
      ),
    );

    denials.push(
      await expectDenied(
        certificationClient,
        'duplicate_correlation',
        `INSERT INTO public.action_proposals (
           id, organization_id, action_type, action_class, parameters,
           parameter_hash, approval_binding_hash, correlation_id, evidence,
           preconditions, status, justification, created_at, expires_at, updated_at
         ) SELECT
           $1, organization_id, action_type, action_class, parameters,
           parameter_hash, approval_binding_hash, correlation_id, evidence,
           preconditions, 'PROPOSED', justification, now(), expires_at, now()
         FROM public.action_proposals
         WHERE id = $2 AND organization_id = $3`,
        [duplicateProposalId, proposalId, CERTIFICATION_ORGANIZATION_ID],
      ),
    );

    denials.push(
      await expectDenied(
        certificationClient,
        'task_update',
        'UPDATE public.tasks SET title = title WHERE false',
      ),
    );
    denials.push(
      await expectDenied(
        certificationClient,
        'approval_insert',
        'INSERT INTO public.action_approvals DEFAULT VALUES',
      ),
    );
    denials.push(
      await expectDenied(
        certificationClient,
        'execution_insert',
        'INSERT INTO public.action_executions DEFAULT VALUES',
      ),
    );

    if (denials.some((proof) => !proof.denied)) {
      throw new Error(
        'Agent proposer certification failed: one or more forbidden operations were unexpectedly allowed.',
      );
    }

    await client.query('ROLLBACK');

    const persisted = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM public.action_proposals
       WHERE organization_id = $1 AND correlation_id = $2`,
      [CERTIFICATION_ORGANIZATION_ID, correlationId],
    );

    if (persisted.rows[0]?.count !== '0') {
      throw new Error(
        'Agent proposer certification failed: rollback-safe proposal persisted unexpectedly.',
      );
    }

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          target: 'staging',
          workload: 'agent-proposer',
          proposerRoleMember: preflight.proposerRoleMember,
          allowedPath: 'PROPOSED -> PENDING_APPROVAL',
          rollbackClean: true,
          denialProofs: denials,
        },
        null,
        2,
      ),
    );
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Keep rollback failure bounded; caller receives only the outer error type.
    }
    throw error;
  } finally {
    client.release();
    await closeDatabasePool();
  }
}

void main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  console.error('Agent proposer staging certification failed.', { errorType });
  process.exitCode = 1;
});
