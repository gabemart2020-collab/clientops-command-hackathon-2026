import type { TenantContext } from './tenant.js';
import type {
  ClientEntity,
  CommitmentEntity,
  CommunicationEntity,
  DecisionEntity,
  MeetingEntity,
  MilestoneEntity,
  ProjectEntity,
  TaskEntity,
  UserEntity,
} from './entities.js';

export interface ClientRepository {
  findByRef(tenant: TenantContext, ref: string): Promise<ClientEntity | null>;
  findById(tenant: TenantContext, id: string): Promise<ClientEntity | null>;
  list(tenant: TenantContext): Promise<ClientEntity[]>;
}

export interface ProjectRepository {
  findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ProjectEntity | null>;
  listByClient(
    tenant: TenantContext,
    clientId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ProjectEntity[]>;
}

export interface MilestoneRepository {
  findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<MilestoneEntity | null>;
  listByProject(
    tenant: TenantContext,
    projectId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<MilestoneEntity[]>;
}

export interface TaskRepository {
  listByProject(
    tenant: TenantContext,
    projectId: string,
  ): Promise<TaskEntity[]>;
}

export interface MeetingRepository {
  findById(tenant: TenantContext, id: string): Promise<MeetingEntity | null>;
  listByClient(
    tenant: TenantContext,
    clientId: string,
  ): Promise<MeetingEntity[]>;
}

export interface CommunicationRepository {
  listByClient(
    tenant: TenantContext,
    clientId: string,
  ): Promise<CommunicationEntity[]>;
}

export interface CommitmentRepository {
  listByClient(
    tenant: TenantContext,
    clientId: string,
  ): Promise<CommitmentEntity[]>;
}

export interface DecisionRepository {
  listByClient(
    tenant: TenantContext,
    clientId: string,
  ): Promise<DecisionEntity[]>;
}

export interface UserRepository {
  findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<UserEntity | null>;
  list(
    tenant: TenantContext,
    options?: RepositoryTransactionOptions,
  ): Promise<UserEntity[]>;
}

import type {
  ActionProposal,
  CreateActionProposalInput,
  ActionStatus,
  ApprovalRecord,
  ActionExecutionRecord,
  ExecutionErrorCode,
  AuditEvent,
} from '@clientops/contracts';

export interface DbClient {
  query<R = unknown>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface RepositoryTransactionOptions {
  client?: DbClient;
  forUpdate?: boolean;
  forShare?: boolean;
}

export interface ActionProposalRepository {
  create(
    proposal: CreateActionProposalInput | ActionProposal,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal>;

  findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal | null>;

  findByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal | null>;

  transitionStatus(
    tenant: TenantContext,
    id: string,
    fromStatus: ActionStatus,
    toStatus: ActionStatus,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal>;

  listPending(
    tenant: TenantContext,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionProposal[]>;
}

export interface ActionApprovalRepository {
  create(
    approval: ApprovalRecord,
    options?: RepositoryTransactionOptions,
  ): Promise<ApprovalRecord>;

  findByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ApprovalRecord | null>;
}

export interface CreateActionExecutionParams {
  id?: string;
  organizationId: string;
  actionProposalId: string;
  actionApprovalId: string;
  executorPrincipal?: 'clientops_trusted_executor';
  targetEntityType?: string;
  parameterHash: string;
  approvalBindingHash: string;
  startedAt?: string;
}

export interface UpdateActionExecutionResultParams {
  status: 'COMPLETED' | 'FAILED';
  targetEntityId?: string;
  errorCode?: ExecutionErrorCode;
  failureSummary?: string;
  completedAt?: string;
}

export interface ActionExecutionRepository {
  create(
    params: CreateActionExecutionParams,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord>;

  findByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord | null>;

  updateResult(
    tenant: TenantContext,
    proposalId: string,
    result: UpdateActionExecutionResultParams,
    options?: RepositoryTransactionOptions,
  ): Promise<ActionExecutionRecord>;
}

export interface CreateControlledTaskParams {
  projectId: string;
  milestoneId?: string | undefined;
  title: string;
  description?: string | undefined;
  assigneeUserId?: string | undefined;
  dueAt?: string | undefined;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  sourceActionProposalId: string;
}

export interface ControlledTaskMutationRepository {
  createControlledTask(
    tenant: TenantContext,
    params: CreateControlledTaskParams,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity>;

  findBySourceProposalId(
    tenant: TenantContext,
    sourceActionProposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity | null>;

  findById(
    tenant: TenantContext,
    id: string,
    options?: RepositoryTransactionOptions,
  ): Promise<TaskEntity | null>;
}

export interface AuditEventRepository {
  append(
    event: AuditEvent,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent>;

  listByProposalId(
    tenant: TenantContext,
    proposalId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent[]>;

  listByCorrelationId(
    tenant: TenantContext,
    correlationId: string,
    options?: RepositoryTransactionOptions,
  ): Promise<AuditEvent[]>;
}

export interface ActionDataRepositories {
  proposals: ActionProposalRepository;
  approvals: ActionApprovalRepository;
  executions: ActionExecutionRepository;
  auditEvents: AuditEventRepository;
  controlledTasks: ControlledTaskMutationRepository;
}

export interface DataRepositories {
  clients: ClientRepository;
  projects: ProjectRepository;
  milestones: MilestoneRepository;
  tasks: TaskRepository;
  meetings: MeetingRepository;
  communications: CommunicationRepository;
  commitments: CommitmentRepository;
  decisions: DecisionRepository;
  users: UserRepository;
  proposals?: ActionProposalRepository;
  approvals?: ActionApprovalRepository;
  executions?: ActionExecutionRepository;
  auditEvents?: AuditEventRepository;
  controlledTasks?: ControlledTaskMutationRepository;
}
