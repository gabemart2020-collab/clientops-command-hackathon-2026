import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ActionProposal,
  CreateActionProposalInput,
  ActionStatus,
  ApprovalRecord,
  ActionExecutionRecord,
  ExecutionErrorCode,
  AuditEvent,
} from '@clientops/contracts';
import {
  ActionProposalSchema,
  ApprovalRecordSchema,
  ActionExecutionRecordSchema,
  AuditEventSchema,
  resolveSafeFailureSummary,
} from '@clientops/contracts';
import type {
  TenantContext,
  ActionProposalRepository,
  ActionApprovalRepository,
  ActionExecutionRepository,
  AuditEventRepository,
  ControlledTaskMutationRepository,
  CreateControlledTaskParams,
  TaskEntity,
  CreateActionExecutionParams,
  UpdateActionExecutionResultParams,
  RepositoryTransactionOptions,
} from '@clientops/domain';
import {
  assertValidTransition,
  IllegalStateTransitionError,
} from '@clientops/policy';
import { assertAppendOnlyOperation } from '@clientops/audit';
import { mapTask } from './postgres-repositories.js';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

function getExecutor(
  defaultDb: Queryable,
  options?: RepositoryTransactionOptions,
): Queryable {
  if (options?.client) {
    return options.client as unknown as Queryable;
  }
  return defaultDb;
}

function toIsoString(val: string | Date): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function parseJsonb<T>(val: unknown): T {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as unknown as T;
    }
  }
  return val as T;
}

export function mapProposalRow(row: Record<string, unknown>): ActionProposal {
  return ActionProposalSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    actionType: row.action_type,
    actionClass: row.action_class,
    parameters: parseJsonb(row.parameters),
    parameterHash: row.parameter_hash,
    approvalBindingHash: row.approval_binding_hash,
    correlationId: row.correlation_id,
    evidence: parseJsonb(row.evidence),
    preconditions: parseJsonb(row.preconditions),
    status: row.status,
    justification: row.justification,
    createdAt: toIsoString(row.created_at as string | Date),
    expiresAt: toIsoString(row.expires_at as string | Date),
    updatedAt: row.updated_at
      ? toIsoString(row.updated_at as string | Date)
      : undefined,
  });
}

export function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  return ApprovalRecordSchema.parse({
    id: row.id,
    actionProposalId: row.action_proposal_id,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    decision: row.decision,
    decidedAt: toIsoString(row.decided_at as string | Date),
    parameterHash: row.parameter_hash as string,
    approvalBindingHash: row.approval_binding_hash,
    validUntil: toIsoString(row.valid_until as string | Date),
    comment: (row.comment as string) ?? undefined,
  });
}

export function mapExecutionRow(
  row: Record<string, unknown>,
): ActionExecutionRecord {
  return ActionExecutionRecordSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    actionProposalId: row.action_proposal_id,
    actionApprovalId: row.action_approval_id,
    executorPrincipal: row.executor_principal ?? 'clientops_trusted_executor',
    status: row.status,
    targetEntityType: row.target_entity_type,
    targetEntityId: (row.target_entity_id as string) ?? undefined,
    parameterHash: row.parameter_hash,
    approvalBindingHash: row.approval_binding_hash,
    errorCode: (row.error_code as string) ?? undefined,
    failureSummary: (row.failure_summary as string) ?? undefined,
    startedAt: toIsoString(row.started_at as string | Date),
    completedAt: row.completed_at
      ? toIsoString(row.completed_at as string | Date)
      : undefined,
  });
}

export function mapAuditEventRow(row: Record<string, unknown>): AuditEvent {
  return AuditEventSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    actionProposalId: (row.action_proposal_id as string) ?? undefined,
    eventType: row.event_type,
    actorId: (row.actor_id as string) ?? undefined,
    parameterHash: (row.parameter_hash as string) ?? undefined,
    approvalBindingHash: (row.approval_binding_hash as string) ?? undefined,
    correlationId: (row.correlation_id as string) ?? undefined,
    payload: parseJsonb(row.payload),
    occurredAt: toIsoString(row.occurred_at as string | Date),
  });
}

export class PostgresActionProposalRepository implements ActionProposalRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    proposal: CreateActionProposalInput | ActionProposal,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal> {
    const validated = ActionProposalSchema.parse(proposal);
    if (validated.status !== 'PROPOSED') {
      throw new Error(
        `Initial proposal status must be "PROPOSED", got "${validated.status}".`,
      );
    }
    const executor = getExecutor(this.db, options);

    const res = await executor.query(
      `INSERT INTO action_proposals (
        id, organization_id, action_type, action_class, parameters, parameter_hash,
        approval_binding_hash, correlation_id, evidence, preconditions, status,
        justification, created_at, expires_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        validated.id,
        validated.organizationId,
        validated.actionType,
        validated.actionClass,
        JSON.stringify(validated.parameters),
        validated.parameterHash,
        validated.approvalBindingHash,
        validated.correlationId,
        JSON.stringify(validated.evidence),
        JSON.stringify(validated.preconditions),
        validated.status,
        validated.justification,
        validated.createdAt,
        validated.expiresAt,
        validated.updatedAt ?? validated.createdAt,
      ],
    );

    return mapProposalRow(res.rows[0]);
  }

  async findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal | null> {
    const executor = getExecutor(this.db, options);
    const query = options?.forUpdate
      ? `SELECT * FROM action_proposals WHERE id = $1 AND organization_id = $2 FOR UPDATE`
      : `SELECT * FROM action_proposals WHERE id = $1 AND organization_id = $2`;
    const res = await executor.query(query, [id, tenant.organizationId]);

    if (res.rows.length === 0) {
      return null;
    }
    return mapProposalRow(res.rows[0]);
  }

  async findByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal | null> {
    const executor = getExecutor(this.db, options);
    const query = options?.forUpdate
      ? `SELECT * FROM action_proposals
         WHERE organization_id = $1 AND correlation_id = $2
         FOR UPDATE`
      : `SELECT * FROM action_proposals
         WHERE organization_id = $1 AND correlation_id = $2`;
    const res = await executor.query(query, [
      tenant.organizationId,
      correlationId,
    ]);
    if (res.rows.length === 0) return null;
    return mapProposalRow(res.rows[0]);
  }

  async transitionStatus(
    tenant: TenantContext,
    id: string,
    fromStatus: ActionStatus,
    toStatus: ActionStatus,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal> {
    assertValidTransition(fromStatus, toStatus);
    const executor = getExecutor(this.db, options);

    const res = await executor.query(
      `UPDATE action_proposals
       SET status = $1, updated_at = now()
       WHERE id = $2 AND organization_id = $3 AND status = $4
       RETURNING *`,
      [toStatus, id, tenant.organizationId, fromStatus],
    );

    if (res.rows.length === 0) {
      const existing = await executor.query(
        `SELECT status FROM action_proposals WHERE id = $1 AND organization_id = $2`,
        [id, tenant.organizationId],
      );

      if (existing.rows.length === 0) {
        throw new Error(
          `Action proposal '${id}' not found in organization '${tenant.organizationId}'`,
        );
      }

      const actualStatus = existing.rows[0].status as ActionStatus;
      throw new IllegalStateTransitionError(
        actualStatus,
        toStatus,
        `Cannot transition proposal '${id}' from status '${actualStatus}' (expected '${fromStatus}') to '${toStatus}'`,
      );
    }

    return mapProposalRow(res.rows[0]);
  }

  async listPending(
    tenant: TenantContext,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal[]> {
    const executor = getExecutor(this.db, options);
    const res = await executor.query(
      `SELECT * FROM action_proposals
       WHERE organization_id = $1 AND status = 'PENDING_APPROVAL' AND expires_at > now()
       ORDER BY created_at DESC`,
      [tenant.organizationId],
    );

    return res.rows.map(mapProposalRow);
  }
}

export class PostgresActionApprovalRepository implements ActionApprovalRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    approval: ApprovalRecord,
    options?: RepositoryTransactionOptions,
  ): Promise<ApprovalRecord> {
    const validated = ApprovalRecordSchema.parse(approval);
    const executor = getExecutor(this.db, options);

    // Repository-level verification
    const propRes = await executor.query(
      `SELECT * FROM action_proposals WHERE id = $1 AND organization_id = $2`,
      [validated.actionProposalId, validated.organizationId],
    );
    if (propRes.rows.length === 0) {
      throw new Error(
        `Cannot approve: proposal '${validated.actionProposalId}' not found in organization '${validated.organizationId}'`,
      );
    }
    const proposal = propRes.rows[0];
    if (proposal.status !== 'PENDING_APPROVAL') {
      throw new Error(
        `Cannot approve proposal '${validated.actionProposalId}': status is '${proposal.status}', expected 'PENDING_APPROVAL'`,
      );
    }
    if (validated.parameterHash !== proposal.parameter_hash) {
      throw new Error(
        `Approval parameterHash mismatch for proposal '${validated.actionProposalId}'`,
      );
    }
    if (validated.approvalBindingHash !== proposal.approval_binding_hash) {
      throw new Error(
        `Approval approvalBindingHash mismatch for proposal '${validated.actionProposalId}'`,
      );
    }
    const propExpiresAt = new Date(proposal.expires_at).getTime();
    const appDecidedAt = new Date(validated.decidedAt).getTime();
    const appValidUntil = new Date(validated.validUntil).getTime();

    if (appDecidedAt > propExpiresAt) {
      throw new Error(
        `Cannot approve expired proposal '${validated.actionProposalId}': decidedAt (${validated.decidedAt}) is after proposal expiresAt (${new Date(proposal.expires_at).toISOString()})`,
      );
    }
    if (appValidUntil <= appDecidedAt) {
      throw new Error(
        `Approval validUntil (${validated.validUntil}) must be strictly after decidedAt (${validated.decidedAt})`,
      );
    }
    if (appValidUntil > propExpiresAt) {
      throw new Error(
        `Approval validUntil (${validated.validUntil}) cannot exceed proposal expiresAt (${new Date(proposal.expires_at).toISOString()})`,
      );
    }

    // Verify authoritative user role from users(id, organization_id)
    const userRes = await executor.query(
      `SELECT role FROM users WHERE id = $1 AND organization_id = $2`,
      [validated.actorId, validated.organizationId],
    );
    if (userRes.rows.length === 0) {
      throw new Error(
        `Actor '${validated.actorId}' not found in organization '${validated.organizationId}'`,
      );
    }
    const userRole = userRes.rows[0].role;
    if (userRole !== 'admin' && userRole !== 'operator') {
      throw new Error(
        `Actor '${validated.actorId}' has role '${userRole}', which is not authorized to approve actions (requires admin or operator)`,
      );
    }
    if (validated.actorRole !== userRole) {
      throw new Error(
        `Actor role mismatch: approval specifies actorRole '${validated.actorRole}' but authoritative user '${validated.actorId}' has role '${userRole}'`,
      );
    }

    const res = await executor.query(
      `INSERT INTO action_approvals (
        id, organization_id, action_proposal_id, actor_id, actor_role, decision,
        parameter_hash, approval_binding_hash, decided_at, valid_until, comment
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        validated.id,
        validated.organizationId,
        validated.actionProposalId,
        validated.actorId,
        validated.actorRole,
        validated.decision,
        validated.parameterHash,
        validated.approvalBindingHash,
        validated.decidedAt,
        validated.validUntil,
        validated.comment ?? null,
      ],
    );

    return mapApprovalRow(res.rows[0]);
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ApprovalRecord | null> {
    const executor = getExecutor(this.db, options);
    const res = await executor.query(
      `SELECT * FROM action_approvals WHERE action_proposal_id = $1 AND organization_id = $2`,
      [proposalId, tenant.organizationId],
    );

    if (res.rows.length === 0) {
      return null;
    }
    return mapApprovalRow(res.rows[0]);
  }
}

export class PostgresActionExecutionRepository implements ActionExecutionRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    params: CreateActionExecutionParams,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord> {
    const record: ActionExecutionRecord = {
      id: params.id ?? randomUUID(),
      organizationId: params.organizationId,
      actionProposalId: params.actionProposalId,
      actionApprovalId: params.actionApprovalId,
      executorPrincipal:
        params.executorPrincipal ?? 'clientops_trusted_executor',
      status: 'EXECUTING',
      targetEntityType: params.targetEntityType ?? 'task',
      targetEntityId: undefined,
      parameterHash: params.parameterHash,
      approvalBindingHash: params.approvalBindingHash,
      errorCode: undefined,
      failureSummary: undefined,
      startedAt: params.startedAt ?? new Date().toISOString(),
      completedAt: undefined,
    };

    const validated = ActionExecutionRecordSchema.parse(record);
    const executor = getExecutor(this.db, options);

    const res = await executor.query(
      `INSERT INTO action_executions (
        id, organization_id, action_proposal_id, action_approval_id, executor_principal,
        status, target_entity_type, target_entity_id, parameter_hash, approval_binding_hash,
        error_code, failure_summary, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        validated.id,
        validated.organizationId,
        validated.actionProposalId,
        validated.actionApprovalId,
        validated.executorPrincipal,
        validated.status,
        validated.targetEntityType,
        validated.targetEntityId ?? null,
        validated.parameterHash,
        validated.approvalBindingHash,
        validated.errorCode ?? null,
        validated.failureSummary ?? null,
        validated.startedAt,
        validated.completedAt ?? null,
      ],
    );

    return mapExecutionRow(res.rows[0]);
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord | null> {
    const executor = getExecutor(this.db, options);
    const res = await executor.query(
      `SELECT * FROM action_executions WHERE action_proposal_id = $1 AND organization_id = $2`,
      [proposalId, tenant.organizationId],
    );

    if (res.rows.length === 0) {
      return null;
    }
    return mapExecutionRow(res.rows[0]);
  }

  async updateResult(
    tenant: TenantContext,
    proposalId: string,
    result: UpdateActionExecutionResultParams,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord> {
    const executor = getExecutor(this.db, options);
    const completedAt = result.completedAt ?? new Date().toISOString();

    let resolvedErrorCode: ExecutionErrorCode | undefined = undefined;
    let resolvedFailureSummary: string | undefined = undefined;

    if (result.status === 'FAILED') {
      const safe = resolveSafeFailureSummary(
        result.errorCode,
        result.failureSummary,
      );
      resolvedErrorCode = safe.errorCode;
      resolvedFailureSummary = safe.failureSummary;
    }

    const res = await executor.query(
      `UPDATE action_executions
       SET status = $1,
           target_entity_id = COALESCE($2, target_entity_id),
           error_code = COALESCE($3, error_code),
           failure_summary = COALESCE($4, failure_summary),
           completed_at = $5
       WHERE action_proposal_id = $6 AND organization_id = $7
       RETURNING *`,
      [
        result.status,
        result.targetEntityId ?? null,
        resolvedErrorCode ?? null,
        resolvedFailureSummary ?? null,
        completedAt,
        proposalId,
        tenant.organizationId,
      ],
    );

    if (res.rows.length === 0) {
      throw new Error(
        `Action execution record for proposal '${proposalId}' not found in organization '${tenant.organizationId}'`,
      );
    }

    return mapExecutionRow(res.rows[0]);
  }
}

export class PostgresAuditEventRepository implements AuditEventRepository {
  constructor(private readonly db: Queryable) {}

  async append(
    event: AuditEvent,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent> {
    assertAppendOnlyOperation('INSERT');
    const validated = AuditEventSchema.parse(event);
    const executor = getExecutor(this.db, options);

    await executor.query(
      `INSERT INTO audit_events (
        id, organization_id, action_proposal_id, event_type, actor_id,
        parameter_hash, approval_binding_hash, correlation_id, payload, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        validated.id,
        validated.organizationId,
        validated.actionProposalId ?? null,
        validated.eventType,
        validated.actorId ?? null,
        validated.parameterHash ?? null,
        validated.approvalBindingHash ?? null,
        validated.correlationId ?? null,
        JSON.stringify(validated.payload),
        validated.occurredAt,
      ],
    );

    return validated;
  }

  async listByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent[]> {
    const executor = getExecutor(this.db, options);
    const res = await executor.query(
      `SELECT * FROM audit_events
       WHERE action_proposal_id = $1 AND organization_id = $2
       ORDER BY occurred_at ASC`,
      [proposalId, tenant.organizationId],
    );

    return res.rows.map(mapAuditEventRow);
  }

  async listByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent[]> {
    const executor = getExecutor(this.db, options);
    const res = await executor.query(
      `SELECT * FROM audit_events
       WHERE correlation_id = $1 AND organization_id = $2
       ORDER BY occurred_at ASC`,
      [correlationId, tenant.organizationId],
    );

    return res.rows.map(mapAuditEventRow);
  }
}

export class PostgresControlledTaskMutationRepository implements ControlledTaskMutationRepository {
  constructor(private readonly db: Queryable) {}

  async createControlledTask(
    tenant: TenantContext,
    params: CreateControlledTaskParams,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity> {
    const executor = getExecutor(this.db, options);
    const id = randomUUID();
    const status = 'open';

    const res = await executor.query(
      `INSERT INTO tasks (
        id, organization_id, project_id, milestone_id, title, description,
        priority, status, assignee_user_id, due_at, source_action_proposal_id,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
      RETURNING *`,
      [
        id,
        tenant.organizationId,
        params.projectId,
        params.milestoneId ?? null,
        params.title,
        params.description ?? null,
        params.priority,
        status,
        params.assigneeUserId ?? null,
        params.dueAt ?? null,
        params.sourceActionProposalId,
      ],
    );

    return mapTask(res.rows[0]);
  }

  async findBySourceProposalId(
    tenant: TenantContext,
    sourceActionProposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity | null> {
    const executor = getExecutor(this.db, options);
    let sql = `SELECT * FROM tasks WHERE organization_id = $1 AND source_action_proposal_id = $2`;
    if (options?.forShare) {
      sql += ` FOR SHARE`;
    } else if (options?.forUpdate) {
      sql += ` FOR UPDATE`;
    }
    const res = await executor.query(sql, [
      tenant.organizationId,
      sourceActionProposalId,
    ]);
    if (res.rows.length === 0) {
      return null;
    }
    return mapTask(res.rows[0]);
  }

  async findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity | null> {
    const executor = getExecutor(this.db, options);
    let sql = `SELECT * FROM tasks WHERE organization_id = $1 AND id = $2`;
    if (options?.forShare) {
      sql += ` FOR SHARE`;
    } else if (options?.forUpdate) {
      sql += ` FOR UPDATE`;
    }
    const res = await executor.query(sql, [tenant.organizationId, id]);
    if (res.rows.length === 0) {
      return null;
    }
    return mapTask(res.rows[0]);
  }
}
