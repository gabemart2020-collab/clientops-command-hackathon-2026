import { randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  ApprovalRecord,
  ActionExecutionRecord,
  ActionStatus,
  CreateActionProposalInput,
  AuditEvent,
} from '@clientops/contracts';
import {
  type ActionApprovalRepository,
  type ActionProposalRepository,
  type ActionExecutionRepository,
  type CreateActionExecutionParams,
  type UpdateActionExecutionResultParams,
  type ControlledTaskMutationRepository,
  type CreateControlledTaskParams,
  type AuditEventRepository,
  type ClientEntity,
  type ClientRepository,
  type ProjectEntity,
  type ProjectRepository,
  type MilestoneEntity,
  type MilestoneRepository,
  type TenantContext,
  type UserEntity,
  type UserRepository,
  type TaskEntity,
  type TaskRepository,
  DEMO_ORGANIZATION_ID,
} from '@clientops/domain';

export class MockActionProposalRepository implements ActionProposalRepository {
  public proposals = new Map<string, ActionProposal>();

  async create(
    proposal: CreateActionProposalInput | ActionProposal,
  ): Promise<ActionProposal> {
    const fullProposal: ActionProposal = {
      ...proposal,
      createdAt: proposal.createdAt ?? new Date().toISOString(),
      updatedAt:
        (proposal as ActionProposal).updatedAt ??
        proposal.createdAt ??
        new Date().toISOString(),
    };
    const clone = JSON.parse(JSON.stringify(fullProposal));
    this.proposals.set(`${proposal.organizationId}:${proposal.id}`, clone);
    return clone;
  }

  async findById(
    tenant: TenantContext,
    id: string,
  ): Promise<ActionProposal | null> {
    const found = this.proposals.get(`${tenant.organizationId}:${id}`);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async findByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
  ): Promise<ActionProposal | null> {
    for (const proposal of this.proposals.values()) {
      if (
        proposal.organizationId === tenant.organizationId &&
        proposal.correlationId === correlationId
      ) {
        return JSON.parse(JSON.stringify(proposal));
      }
    }
    return null;
  }

  async transitionStatus(
    tenant: TenantContext,
    id: string,
    fromStatus: ActionStatus,
    toStatus: ActionStatus,
  ): Promise<ActionProposal> {
    const current = await this.findById(tenant, id);
    if (!current) throw new Error(`Proposal not found: ${id}`);
    if (current.status !== fromStatus) {
      throw new Error(
        `Invalid status transition from ${current.status} to ${toStatus}`,
      );
    }
    const updated = { ...current, status: toStatus };
    this.proposals.set(`${tenant.organizationId}:${id}`, updated);
    return updated;
  }

  async listPending(tenant: TenantContext): Promise<ActionProposal[]> {
    const results: ActionProposal[] = [];
    for (const p of this.proposals.values()) {
      if (
        p.organizationId === tenant.organizationId &&
        p.status === 'PENDING_APPROVAL'
      ) {
        results.push(JSON.parse(JSON.stringify(p)));
      }
    }
    return results;
  }

  async delete(id: string, tenant: TenantContext): Promise<boolean> {
    return this.proposals.delete(`${tenant.organizationId}:${id}`);
  }
}

export class MockActionApprovalRepository implements ActionApprovalRepository {
  public approvals = new Map<string, ApprovalRecord>();

  async create(approval: ApprovalRecord): Promise<ApprovalRecord> {
    const key = `${approval.organizationId}:${approval.actionProposalId}`;
    if (this.approvals.has(key)) {
      throw new Error(
        `Approval for proposal '${approval.actionProposalId}' already exists. Approvals are unique and immutable.`,
      );
    }
    const clone = JSON.parse(JSON.stringify(approval));
    this.approvals.set(key, clone);
    return clone;
  }

  async findById(
    tenant: TenantContext,
    id: string,
  ): Promise<ApprovalRecord | null> {
    for (const app of this.approvals.values()) {
      if (app.organizationId === tenant.organizationId && app.id === id) {
        return JSON.parse(JSON.stringify(app));
      }
    }
    return null;
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<ApprovalRecord | null> {
    const key = `${tenant.organizationId}:${proposalId}`;
    const found = this.approvals.get(key);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }
}

export class MockActionExecutionRepository implements ActionExecutionRepository {
  public executions = new Map<string, ActionExecutionRecord>();

  async create(
    params: CreateActionExecutionParams,
  ): Promise<ActionExecutionRecord> {
    const key = `${params.organizationId}:${params.actionProposalId}`;
    if (this.executions.has(key)) {
      throw new Error(
        `Execution for proposal '${params.actionProposalId}' already exists.`,
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
    this.executions.set(key, record);
    return JSON.parse(JSON.stringify(record));
  }

  async findByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<ActionExecutionRecord | null> {
    const key = `${tenant.organizationId}:${proposalId}`;
    const found = this.executions.get(key);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async updateResult(
    tenant: TenantContext,
    proposalId: string,
    result: UpdateActionExecutionResultParams,
  ): Promise<ActionExecutionRecord> {
    const key = `${tenant.organizationId}:${proposalId}`;
    const found = this.executions.get(key);
    if (!found) throw new Error(`Execution not found: ${proposalId}`);
    const updated: ActionExecutionRecord = {
      ...found,
      status: result.status,
      targetEntityId: result.targetEntityId ?? found.targetEntityId,
      errorCode: result.errorCode ?? found.errorCode,
      failureSummary: result.failureSummary ?? found.failureSummary,
      completedAt: result.completedAt ?? new Date().toISOString(),
    };
    this.executions.set(key, updated);
    return JSON.parse(JSON.stringify(updated));
  }
}

export class MockControlledTaskMutationRepository implements ControlledTaskMutationRepository {
  public tasks = new Map<string, TaskEntity>();
  public tasksByProposal = new Map<string, string>();
  public shouldFailMutation = false;

  async createControlledTask(
    tenant: TenantContext,
    params: CreateControlledTaskParams,
  ): Promise<TaskEntity> {
    if (this.shouldFailMutation) {
      throw new Error('Simulated database task insertion failure.');
    }
    const proposalKey = `${tenant.organizationId}:${params.sourceActionProposalId}`;
    if (this.tasksByProposal.has(proposalKey)) {
      throw new Error(
        `Task already created for proposal '${params.sourceActionProposalId}'.`,
      );
    }
    const id = randomUUID();
    const taskKey = `${tenant.organizationId}:${id}`;
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
    this.tasks.set(taskKey, task);
    this.tasksByProposal.set(proposalKey, id);
    return JSON.parse(JSON.stringify(task));
  }

  async findBySourceProposalId(
    tenant: TenantContext,
    sourceActionProposalId: string,
  ): Promise<TaskEntity | null> {
    const proposalKey = `${tenant.organizationId}:${sourceActionProposalId}`;
    const taskId = this.tasksByProposal.get(proposalKey);
    if (!taskId) return null;
    const task = this.tasks.get(`${tenant.organizationId}:${taskId}`);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }

  async findById(
    tenant: TenantContext,
    id: string,
  ): Promise<TaskEntity | null> {
    const task = this.tasks.get(`${tenant.organizationId}:${id}`);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }
}

export class MockAuditEventRepository implements AuditEventRepository {
  private events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<AuditEvent> {
    const clone = JSON.parse(JSON.stringify(event));
    this.events.push(clone);
    return clone;
  }

  async listByProposalId(
    tenant: TenantContext,
    proposalId: string,
  ): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) =>
        e.organizationId === tenant.organizationId &&
        e.actionProposalId === proposalId,
    );
  }

  async listByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
  ): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) =>
        e.organizationId === tenant.organizationId &&
        e.correlationId === correlationId,
    );
  }

  getEvents(): AuditEvent[] {
    return [...this.events];
  }
}

export function createMockDomainData() {
  const users: UserEntity[] = [
    {
      id: '10000000-0000-4000-8000-000000000011',
      organizationId: DEMO_ORGANIZATION_ID,
      email: 'alice@clientops.demo',
      name: 'Alice Walker',
      role: 'operator',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: '10000000-0000-4000-8000-000000000001',
      organizationId: DEMO_ORGANIZATION_ID,
      email: 'gabe@clientops.demo',
      name: 'Gabe Martinez',
      role: 'admin',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: '10000000-0000-4000-8000-000000000004',
      organizationId: DEMO_ORGANIZATION_ID,
      email: 'elena@clientops.demo',
      name: 'Elena Rostova',
      role: 'viewer',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  const clients: ClientEntity[] = [
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      organizationId: DEMO_ORGANIZATION_ID,
      name: 'Acme Labs',
      slug: 'acme-labs',
      industry: 'Biotechnology',
      tier: 'enterprise',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 'c0000000-0000-4000-8000-000000000002',
      organizationId: DEMO_ORGANIZATION_ID,
      name: 'Northstar Analytics',
      slug: 'northstar-analytics',
      industry: 'Healthcare Technology',
      tier: 'standard',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  const projects: ProjectEntity[] = [
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      organizationId: DEMO_ORGANIZATION_ID,
      clientId: 'c0000000-0000-4000-8000-000000000001',
      name: 'Cloud Analytics Migration',
      status: 'active',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-10-14T10:00:00.000Z',
    },
  ];

  const tasks: TaskEntity[] = [];

  const milestones: MilestoneEntity[] = [
    {
      id: 'b0000000-0000-4000-8000-000000000001',
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: 'a0000000-0000-4000-8000-000000000001',
      title: 'Phase 1 Initial Ingestion',
      status: 'completed',
      dueAt: '2026-09-15T00:00:00.000Z',
      completedAt: '2026-09-14T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    },
    {
      id: 'b0000000-0000-4000-8000-000000000002',
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: 'a0000000-0000-4000-8000-000000000001',
      title: 'Phase 2 Real-Time Pipeline',
      status: 'in_progress',
      dueAt: '2026-10-20T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  const userRepository: UserRepository = {
    findById: async (tenant: TenantContext, id: string) =>
      users.find(
        (u) => u.organizationId === tenant.organizationId && u.id === id,
      ) ?? null,
    list: async (tenant: TenantContext) =>
      users.filter((u) => u.organizationId === tenant.organizationId),
  };

  const clientRepository: ClientRepository = {
    findById: async (tenant: TenantContext, id: string) =>
      clients.find(
        (c) => c.organizationId === tenant.organizationId && c.id === id,
      ) ?? null,
    findByRef: async (tenant: TenantContext, ref: string) =>
      clients.find(
        (c) =>
          c.organizationId === tenant.organizationId &&
          (c.id === ref || c.name.toLowerCase() === ref.toLowerCase()),
      ) ?? null,
    list: async (tenant: TenantContext) =>
      clients.filter((c) => c.organizationId === tenant.organizationId),
  };

  const projectRepository: ProjectRepository = {
    findById: async (tenant: TenantContext, id: string) =>
      projects.find(
        (p) => p.organizationId === tenant.organizationId && p.id === id,
      ) ?? null,
    listByClient: async (tenant: TenantContext, clientId: string) =>
      projects.filter(
        (p) =>
          p.organizationId === tenant.organizationId && p.clientId === clientId,
      ),
  };

  const milestoneRepository: MilestoneRepository = {
    findById: async (tenant: TenantContext, id: string) =>
      milestones.find(
        (m) => m.organizationId === tenant.organizationId && m.id === id,
      ) ?? null,
    listByProject: async (tenant: TenantContext, projectId: string) =>
      milestones.filter(
        (m) =>
          m.organizationId === tenant.organizationId &&
          m.projectId === projectId,
      ),
  };

  const taskRepository: TaskRepository = {
    listByProject: async (tenant: TenantContext, projectId: string) =>
      tasks.filter(
        (t) =>
          t.organizationId === tenant.organizationId &&
          t.projectId === projectId,
      ),
  };

  return {
    users,
    clients,
    projects,
    milestones,
    tasks,
    userRepository,
    clientRepository,
    projectRepository,
    milestoneRepository,
    taskRepository,
  };
}
