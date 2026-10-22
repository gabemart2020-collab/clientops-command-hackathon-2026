import { randomUUID } from 'node:crypto';
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
} from '@clientops/domain';
import {
  assertValidTransition,
  IllegalStateTransitionError,
} from '@clientops/policy';
import { assertAppendOnlyOperation } from '@clientops/audit';

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

export class InMemoryActionProposalRepository implements ActionProposalRepository {
  private readonly proposals: Map<string, ActionProposal> = new Map();
  private readonly proposalIdsByCorrelation: Map<string, string> = new Map();

  private makeKey(orgId: string, id: string): string {
    return `${orgId}:${id}`;
  }

  private makeCorrelationKey(orgId: string, correlationId: string): string {
    return `${orgId}:${correlationId}`;
  }

  async create(
    proposal: CreateActionProposalInput | ActionProposal,
  ): Promise<ActionProposal> {
    const validated = ActionProposalSchema.parse(clone(proposal));
    if (validated.status !== 'PROPOSED') {
      throw new Error(
        `Initial proposal status must be "PROPOSED", got "${validated.status}".`,
      );
    }
    const key = this.makeKey(validated.organizationId, validated.id);
    const correlationKey = this.makeCorrelationKey(
      validated.organizationId,
      validated.correlationId,
    );

    if (this.proposals.has(key)) {
      throw new Error(`Action proposal '${validated.id}' already exists.`);
    }
    if (this.proposalIdsByCorrelation.has(correlationKey)) {
      throw new Error(
        `Action proposal correlation '${validated.correlationId}' already exists in organization '${validated.organizationId}'.`,
      );
    }

    this.proposals.set(key, validated);
    this.proposalIdsByCorrelation.set(correlationKey, validated.id);
    return clone(validated);
  }

  async findById(
    tenant: TenantContext,
    id: string,
  ): Promise<ActionProposal | null> {
    const key = this.makeKey(tenant.organizationId, id);
    const found = this.proposals.get(key);
    return found ? clone(found) : null;
  }

  async findByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
  ): Promise<ActionProposal | null> {
    const proposalId = this.proposalIdsByCorrelation.get(
      this.makeCorrelationKey(tenant.organizationId, correlationId),
    );
    if (!proposalId) return null;
    return this.findById(tenant, proposalId);
  }

  async transitionStatus(
    tenant: TenantContext,
    id: string,
    fromStatus: ActionStatus,
    toStatus: ActionStatus,
  ): Promise<ActionProposal> {
    assertValidTransition(fromStatus, toStatus);
    const key = this.makeKey(tenant.organizationId, id);
    const found = this.proposals.get(key);

    if (!found) {
      throw new Error(
        `Action proposal '${id}' not found in organization '${tenant.organizationId}'`,
      );
    }

    if (found.status !== fromStatus) {
      throw new IllegalStateTransitionError(
        found.status,
        toStatus,
        `Cannot transition proposal '${id}' from status '${found.status}' (expected '${fromStatus}') to '${toStatus}'`,
      );
    }

    const updated: ActionProposal = {
      ...found,
      status: toStatus,
      updatedAt: new Date().toISOString(),
    };

    this.proposals.set(key, updated);
    return clone(updated);
  }

  async listPending(tenant: TenantContext): Promise<ActionProposal[]> {
    const now = new Date().toISOString();
    const results: ActionProposal[] = [];

    for (const proposal of this.proposals.values()) {
      if (
        proposal.organizationId === tenant.organizationId &&
        proposal.status === 'PENDING_APPROVAL' &&
        proposal.expiresAt > now
      ) {
        results.push(clone(proposal));
      }
    }

    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class InMemoryActionApprovalRepository implements ActionApprovalRepository {
  private readonly approvalsByProposal: Map<string, ApprovalRecord> = new Map();

  private makeKey(orgId: string, proposalId: string): string {
    return `${orgId}:${proposalId}`;
  }

  async create(approval: ApprovalRecord): Promise<ApprovalRecord> {
    const validated = ApprovalRecordSchema.parse(clone(approval));
    const key = this.makeKey(
      validated.organizationId,
      validated.actionProposalId,
    );

    const appDecidedAt = new Date(validated.decidedAt).getTime();
    const appValidUntil = new Date(validated.validUntil).getTime();
    if (appValidUntil <= appDecidedAt) {
      throw new Error(
        `Approval validUntil (${validated.validUntil}) must be strictly after decidedAt (${validated.decidedAt})`,
      );
    }

    if (this.approvalsByProposal.has(key)) {
      throw new Error(
        `Approval for proposal '${validated.actionProposalId}' already exists. Approvals are unique and immutable.`,
      );
    }

    this.approvalsByProposal.set(key, validated);
    return clone(validated);
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<ApprovalRecord | null> {
    const key = this.makeKey(tenant.organizationId, proposalId);
    const found = this.approvalsByProposal.get(key);
    return found ? clone(found) : null;
  }
}

export class InMemoryActionExecutionRepository implements ActionExecutionRepository {
  private readonly executionsByProposal: Map<string, ActionExecutionRecord> =
    new Map();

  private makeKey(orgId: string, proposalId: string): string {
    return `${orgId}:${proposalId}`;
  }

  async create(
    params: CreateActionExecutionParams,
  ): Promise<ActionExecutionRecord> {
    const key = this.makeKey(params.organizationId, params.actionProposalId);

    if (this.executionsByProposal.has(key)) {
      throw new Error(
        `Execution for proposal '${params.actionProposalId}' already exists. Action executions are strictly idempotent.`,
      );
    }

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
    this.executionsByProposal.set(key, validated);
    return clone(validated);
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<ActionExecutionRecord | null> {
    const key = this.makeKey(tenant.organizationId, proposalId);
    const found = this.executionsByProposal.get(key);
    return found ? clone(found) : null;
  }

  async updateResult(
    tenant: TenantContext,
    proposalId: string,
    result: UpdateActionExecutionResultParams,
  ): Promise<ActionExecutionRecord> {
    const key = this.makeKey(tenant.organizationId, proposalId);
    const found = this.executionsByProposal.get(key);

    if (!found) {
      throw new Error(
        `Action execution record for proposal '${proposalId}' not found in organization '${tenant.organizationId}'`,
      );
    }

    if (found.status !== 'EXECUTING') {
      throw new Error(
        `Cannot transition action execution from terminal status '${found.status}' to '${result.status}'`,
      );
    }

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

    const updated: ActionExecutionRecord = {
      ...found,
      status: result.status,
      targetEntityId: result.targetEntityId ?? found.targetEntityId,
      errorCode: resolvedErrorCode ?? found.errorCode,
      failureSummary: resolvedFailureSummary ?? found.failureSummary,
      completedAt: result.completedAt ?? new Date().toISOString(),
    };

    const validated = ActionExecutionRecordSchema.parse(updated);
    this.executionsByProposal.set(key, validated);
    return clone(validated);
  }
}

export class InMemoryAuditEventRepository implements AuditEventRepository {
  private readonly events: AuditEvent[] = [];

  getEvents(): AuditEvent[] {
    return this.events.map(clone);
  }

  async append(event: AuditEvent): Promise<AuditEvent> {
    assertAppendOnlyOperation('INSERT');
    const validated = AuditEventSchema.parse(clone(event));
    this.events.push(validated);
    return clone(validated);
  }

  async listByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<AuditEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.organizationId === tenant.organizationId &&
          e.actionProposalId === proposalId,
      )
      .map(clone)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async listByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
  ): Promise<AuditEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.organizationId === tenant.organizationId &&
          e.correlationId === correlationId,
      )
      .map(clone)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

export class InMemoryControlledTaskMutationRepository implements ControlledTaskMutationRepository {
  private readonly tasks: Map<string, TaskEntity> = new Map();
  private readonly tasksByProposal: Map<string, string> = new Map();

  constructor(initialTasks?: TaskEntity[]) {
    if (initialTasks) {
      for (const t of initialTasks) {
        const key = `${t.organizationId}:${t.id}`;
        this.tasks.set(key, clone(t));
        if (t.sourceActionProposalId) {
          this.tasksByProposal.set(
            `${t.organizationId}:${t.sourceActionProposalId}`,
            t.id,
          );
        }
      }
    }
  }

  private makeKey(orgId: string, id: string): string {
    return `${orgId}:${id}`;
  }

  async createControlledTask(
    tenant: TenantContext,
    params: CreateControlledTaskParams,
  ): Promise<TaskEntity> {
    const proposalKey = this.makeKey(
      tenant.organizationId,
      params.sourceActionProposalId,
    );
    if (this.tasksByProposal.has(proposalKey)) {
      throw new Error(
        `Task already created for proposal '${params.sourceActionProposalId}'. Controlled task creation is strictly idempotent.`,
      );
    }

    const id = randomUUID();
    const taskKey = this.makeKey(tenant.organizationId, id);
    if (this.tasks.has(taskKey)) {
      throw new Error(`Task '${id}' already exists.`);
    }

    const now = new Date().toISOString();
    const task: TaskEntity = {
      id,
      organizationId: tenant.organizationId,
      projectId: params.projectId,
      milestoneId: params.milestoneId,
      title: params.title,
      description: params.description,
      priority: params.priority,
      status: 'open',
      assigneeUserId: params.assigneeUserId,
      dueAt: params.dueAt,
      completedAt: undefined,
      sourceActionProposalId: params.sourceActionProposalId,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(taskKey, clone(task));
    this.tasksByProposal.set(proposalKey, id);
    return clone(task);
  }

  async findBySourceProposalId(
    tenant: TenantContext,
    sourceActionProposalId: string,
  ): Promise<TaskEntity | null> {
    const proposalKey = this.makeKey(
      tenant.organizationId,
      sourceActionProposalId,
    );
    const taskId = this.tasksByProposal.get(proposalKey);
    if (!taskId) return null;
    const taskKey = this.makeKey(tenant.organizationId, taskId);
    const task = this.tasks.get(taskKey);
    return task ? clone(task) : null;
  }

  async findById(
    tenant: TenantContext,
    id: string,
  ): Promise<TaskEntity | null> {
    const taskKey = this.makeKey(tenant.organizationId, id);
    const task = this.tasks.get(taskKey);
    return task ? clone(task) : null;
  }
}
