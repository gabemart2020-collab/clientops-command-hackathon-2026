import type { Pool, PoolClient } from 'pg';
import type {
  ClientEntity,
  CommitmentEntity,
  CommunicationEntity,
  DecisionEntity,
  MeetingEntity,
  MilestoneEntity,
  ProjectEntity,
  TaskEntity,
  TenantContext,
  UserEntity,
  DataRepositories,
  ClientRepository,
  ProjectRepository,
  MilestoneRepository,
  TaskRepository,
  MeetingRepository,
  CommunicationRepository,
  CommitmentRepository,
  DecisionRepository,
  UserRepository,
  RepositoryTransactionOptions,
} from '@clientops/domain';

type Queryable = Pick<Pool | PoolClient, 'query'>;

interface ClientRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  industry: string;
  tier: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  client_id: string;
  name: string;
  status: string;
  lead_user_id?: string | null;
  target_completion_at?: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MilestoneRow {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  status: string;
  due_at: string | Date;
  completed_at?: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface TaskRow {
  id: string;
  organization_id: string;
  project_id: string;
  milestone_id?: string | null;
  title: string;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
  status: string;
  assignee_user_id?: string | null;
  due_at?: string | Date | null;
  completed_at?: string | Date | null;
  source_action_proposal_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MeetingRow {
  id: string;
  organization_id: string;
  client_id: string;
  project_id?: string | null;
  title: string;
  scheduled_at: string | Date;
  status: string;
  summary?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface CommunicationRow {
  id: string;
  organization_id: string;
  client_id: string;
  channel: string;
  subject: string;
  summary: string;
  occurred_at: string | Date;
  requires_response: boolean;
  resolved_at?: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface CommitmentRow {
  id: string;
  organization_id: string;
  client_id: string;
  project_id?: string | null;
  description: string;
  owner_user_id: string;
  due_at: string | Date;
  status: 'open' | 'fulfilled' | 'cancelled';
  fulfilled_at?: string | Date | null;
  originating_evidence_type?: string | null;
  originating_evidence_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DecisionRow {
  id: string;
  organization_id: string;
  client_id: string;
  project_id?: string | null;
  title: string;
  rationale: string;
  decided_at: string | Date;
  decided_by_user_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  role: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapClient(row: ClientRow): ClientEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    industry: row.industry,
    tier: row.tier,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapProject(row: ProjectRow): ProjectEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientId: row.client_id,
    name: row.name,
    status: row.status,
    leadUserId: row.lead_user_id ?? undefined,
    targetCompletionAt: row.target_completion_at
      ? new Date(row.target_completion_at).toISOString()
      : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapMilestone(row: MilestoneRow): MilestoneEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    dueAt: new Date(row.due_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function mapTask(row: TaskRow): TaskEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    milestoneId: row.milestone_id ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    priority:
      (row.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined) ??
      'medium',
    status: row.status,
    assigneeUserId: row.assignee_user_id ?? undefined,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : undefined,
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : undefined,
    sourceActionProposalId: row.source_action_proposal_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapMeeting(row: MeetingRow): MeetingEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientId: row.client_id,
    projectId: row.project_id ?? undefined,
    title: row.title,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    status: row.status,
    summary: row.summary ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapCommunication(row: CommunicationRow): CommunicationEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientId: row.client_id,
    channel: row.channel,
    subject: row.subject,
    summary: row.summary,
    occurredAt: new Date(row.occurred_at).toISOString(),
    requiresResponse: Boolean(row.requires_response),
    resolvedAt: row.resolved_at
      ? new Date(row.resolved_at).toISOString()
      : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapCommitment(row: CommitmentRow): CommitmentEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientId: row.client_id,
    projectId: row.project_id ?? undefined,
    description: row.description,
    ownerUserId: row.owner_user_id,
    dueAt: new Date(row.due_at).toISOString(),
    status: row.status,
    fulfilledAt: row.fulfilled_at
      ? new Date(row.fulfilled_at).toISOString()
      : undefined,
    originatingEvidenceType: row.originating_evidence_type ?? undefined,
    originatingEvidenceId: row.originating_evidence_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapDecision(row: DecisionRow): DecisionEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientId: row.client_id,
    projectId: row.project_id ?? undefined,
    title: row.title,
    rationale: row.rationale,
    decidedAt: new Date(row.decided_at).toISOString(),
    decidedByUserId: row.decided_by_user_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapUser(row: UserRow): UserEntity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresDataStore implements DataRepositories {
  constructor(private readonly db: Queryable) {}

  readonly clients: ClientRepository = {
    findByRef: async (
      tenant: TenantContext,
      ref: string,
    ): Promise<ClientEntity | null> => {
      const trimmed = ref.trim();
      const res = await this.db.query(
        `SELECT * FROM clients
         WHERE organization_id = $1
           AND (id::text = $2 OR LOWER(slug) = LOWER($2) OR LOWER(name) = LOWER($2))`,
        [tenant.organizationId, trimmed],
      );

      if (res.rows.length === 1 && res.rows[0]) {
        return mapClient(res.rows[0]);
      }
      if (res.rows.length > 1) {
        throw new Error(
          `Ambiguous client reference: "${ref}" matches multiple clients in organization`,
        );
      }

      // Try starts-with match
      const prefixRes = await this.db.query(
        `SELECT * FROM clients
         WHERE organization_id = $1
           AND LOWER(name) LIKE LOWER($2) || '%'`,
        [tenant.organizationId, trimmed],
      );
      if (prefixRes.rows.length === 1 && prefixRes.rows[0]) {
        return mapClient(prefixRes.rows[0]);
      }
      if (prefixRes.rows.length > 1) {
        throw new Error(
          `Ambiguous client reference: "${ref}" matches multiple clients in organization`,
        );
      }

      return null;
    },

    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<ClientEntity | null> => {
      const res = await this.db.query(
        `SELECT * FROM clients WHERE organization_id = $1 AND id = $2`,
        [tenant.organizationId, id],
      );
      return res.rows[0] ? mapClient(res.rows[0]) : null;
    },

    list: async (tenant: TenantContext): Promise<ClientEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM clients WHERE organization_id = $1 ORDER BY name ASC`,
        [tenant.organizationId],
      );
      return res.rows.map(mapClient);
    },
  };

  readonly projects: ProjectRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
      options?: RepositoryTransactionOptions,
    ): Promise<ProjectEntity | null> => {
      const runner = options?.client ?? this.db;
      let sql = `SELECT * FROM projects WHERE organization_id = $1 AND id = $2`;
      if (options?.forShare) {
        sql += ` FOR SHARE`;
      } else if (options?.forUpdate) {
        sql += ` FOR UPDATE`;
      }
      const res = await runner.query(sql, [tenant.organizationId, id]);
      return res.rows[0] ? mapProject(res.rows[0] as ProjectRow) : null;
    },

    listByClient: async (
      tenant: TenantContext,
      clientId: string,
      options?: RepositoryTransactionOptions,
    ): Promise<ProjectEntity[]> => {
      const runner = options?.client ?? this.db;
      const res = await runner.query(
        `SELECT * FROM projects WHERE organization_id = $1 AND client_id = $2 ORDER BY created_at ASC`,
        [tenant.organizationId, clientId],
      );
      return (res.rows as ProjectRow[]).map(mapProject);
    },
  };

  readonly milestones: MilestoneRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
      options?: RepositoryTransactionOptions,
    ): Promise<MilestoneEntity | null> => {
      const runner = options?.client ?? this.db;
      let sql = `SELECT * FROM milestones WHERE organization_id = $1 AND id = $2`;
      if (options?.forShare) {
        sql += ` FOR SHARE`;
      } else if (options?.forUpdate) {
        sql += ` FOR UPDATE`;
      }
      const res = await runner.query(sql, [tenant.organizationId, id]);
      return res.rows[0] ? mapMilestone(res.rows[0] as MilestoneRow) : null;
    },

    listByProject: async (
      tenant: TenantContext,
      projectId: string,
      options?: RepositoryTransactionOptions,
    ): Promise<MilestoneEntity[]> => {
      const runner = options?.client ?? this.db;
      let sql = `SELECT * FROM milestones WHERE organization_id = $1 AND project_id = $2 ORDER BY due_at ASC`;
      if (options?.forShare) {
        sql += ` FOR SHARE`;
      }
      const res = await runner.query(sql, [tenant.organizationId, projectId]);
      return (res.rows as MilestoneRow[]).map(mapMilestone);
    },
  };

  readonly tasks: TaskRepository = {
    listByProject: async (
      tenant: TenantContext,
      projectId: string,
    ): Promise<TaskEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM tasks WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
        [tenant.organizationId, projectId],
      );
      return res.rows.map(mapTask);
    },
  };

  readonly meetings: MeetingRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<MeetingEntity | null> => {
      const res = await this.db.query(
        `SELECT * FROM meetings WHERE organization_id = $1 AND id = $2`,
        [tenant.organizationId, id],
      );
      return res.rows[0] ? mapMeeting(res.rows[0]) : null;
    },

    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<MeetingEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM meetings WHERE organization_id = $1 AND client_id = $2 ORDER BY scheduled_at ASC`,
        [tenant.organizationId, clientId],
      );
      return res.rows.map(mapMeeting);
    },
  };

  readonly communications: CommunicationRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<CommunicationEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM communications WHERE organization_id = $1 AND client_id = $2 ORDER BY occurred_at DESC`,
        [tenant.organizationId, clientId],
      );
      return res.rows.map(mapCommunication);
    },
  };

  readonly commitments: CommitmentRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<CommitmentEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM commitments WHERE organization_id = $1 AND client_id = $2 ORDER BY due_at ASC`,
        [tenant.organizationId, clientId],
      );
      return res.rows.map(mapCommitment);
    },
  };

  readonly decisions: DecisionRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<DecisionEntity[]> => {
      const res = await this.db.query(
        `SELECT * FROM decisions WHERE organization_id = $1 AND client_id = $2 ORDER BY decided_at DESC`,
        [tenant.organizationId, clientId],
      );
      return res.rows.map(mapDecision);
    },
  };

  readonly users: UserRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
      options?: RepositoryTransactionOptions,
    ): Promise<UserEntity | null> => {
      const runner = options?.client ?? this.db;
      let sql = `SELECT * FROM users WHERE organization_id = $1 AND id = $2`;
      if (options?.forShare) {
        sql += ` FOR SHARE`;
      } else if (options?.forUpdate) {
        sql += ` FOR UPDATE`;
      }
      const res = await runner.query(sql, [tenant.organizationId, id]);
      return res.rows[0] ? mapUser(res.rows[0] as UserRow) : null;
    },

    list: async (
      tenant: TenantContext,
      options?: RepositoryTransactionOptions,
    ): Promise<UserEntity[]> => {
      const runner = options?.client ?? this.db;
      const res = await runner.query(
        `SELECT * FROM users WHERE organization_id = $1 ORDER BY name ASC`,
        [tenant.organizationId],
      );
      return (res.rows as UserRow[]).map(mapUser);
    },
  };
}

export function createPostgresDataStore(db: Queryable): DataRepositories {
  return new PostgresDataStore(db);
}
