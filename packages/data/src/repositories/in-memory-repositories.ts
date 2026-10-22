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
  OrganizationEntity,
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
} from '@clientops/domain';
import {
  createDemoSeedData,
  type SeedDataCollection,
} from '../seed/demo-data.js';

export class InMemoryDataStore implements DataRepositories {
  private organizations: OrganizationEntity[];
  private usersList: UserEntity[];
  private clientsList: ClientEntity[];
  private projectsList: ProjectEntity[];
  private milestonesList: MilestoneEntity[];
  private tasksList: TaskEntity[];
  private meetingsList: MeetingEntity[];
  private communicationsList: CommunicationEntity[];
  private commitmentsList: CommitmentEntity[];
  private decisionsList: DecisionEntity[];

  constructor(data: SeedDataCollection = createDemoSeedData()) {
    // Deep clone to ensure clean deterministic isolated state
    this.organizations = JSON.parse(JSON.stringify(data.organizations));
    this.usersList = JSON.parse(JSON.stringify(data.users));
    this.clientsList = JSON.parse(JSON.stringify(data.clients));
    this.projectsList = JSON.parse(JSON.stringify(data.projects));
    this.milestonesList = JSON.parse(JSON.stringify(data.milestones));
    this.tasksList = JSON.parse(JSON.stringify(data.tasks));
    this.meetingsList = JSON.parse(JSON.stringify(data.meetings));
    this.communicationsList = JSON.parse(JSON.stringify(data.communications));
    this.commitmentsList = JSON.parse(JSON.stringify(data.commitments));
    this.decisionsList = JSON.parse(JSON.stringify(data.decisions));
  }

  readonly clients: ClientRepository = {
    findByRef: async (
      tenant: TenantContext,
      ref: string,
    ): Promise<ClientEntity | null> => {
      const normalized = ref.trim().toLowerCase();
      // Search scoped strictly to this tenant's organization
      const tenantClients = this.clientsList.filter(
        (c) => c.organizationId === tenant.organizationId,
      );

      // 1. Exact ID match
      const byId = tenantClients.find((c) => c.id.toLowerCase() === normalized);
      if (byId) return { ...byId };

      // 2. Exact slug match
      const bySlug = tenantClients.find(
        (c) => c.slug.toLowerCase() === normalized,
      );
      if (bySlug) return { ...bySlug };

      // 3. Exact name match (case-insensitive)
      const byName = tenantClients.filter(
        (c) => c.name.toLowerCase() === normalized,
      );
      if (byName.length > 1) {
        throw new Error(
          `Ambiguous client reference: "${ref}" matches multiple clients in organization`,
        );
      }
      if (byName.length === 1 && byName[0]) {
        return { ...byName[0] };
      }

      // 4. Starts-with match for convenience if unambiguous
      const prefixMatches = tenantClients.filter((c) =>
        c.name.toLowerCase().startsWith(normalized),
      );
      if (prefixMatches.length === 1 && prefixMatches[0]) {
        return { ...prefixMatches[0] };
      }
      if (prefixMatches.length > 1) {
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
      const match = this.clientsList.find(
        (c) => c.organizationId === tenant.organizationId && c.id === id,
      );
      return match ? { ...match } : null;
    },

    list: async (tenant: TenantContext): Promise<ClientEntity[]> => {
      return this.clientsList
        .filter((c) => c.organizationId === tenant.organizationId)
        .map((c) => ({ ...c }));
    },
  };

  readonly projects: ProjectRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<ProjectEntity | null> => {
      const match = this.projectsList.find(
        (p) => p.organizationId === tenant.organizationId && p.id === id,
      );
      return match ? { ...match } : null;
    },

    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<ProjectEntity[]> => {
      return this.projectsList
        .filter(
          (p) =>
            p.organizationId === tenant.organizationId &&
            p.clientId === clientId,
        )
        .map((p) => ({ ...p }));
    },
  };

  readonly milestones: MilestoneRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<MilestoneEntity | null> => {
      const match = this.milestonesList.find(
        (m) => m.organizationId === tenant.organizationId && m.id === id,
      );
      return match ? { ...match } : null;
    },

    listByProject: async (
      tenant: TenantContext,
      projectId: string,
    ): Promise<MilestoneEntity[]> => {
      return this.milestonesList
        .filter(
          (m) =>
            m.organizationId === tenant.organizationId &&
            m.projectId === projectId,
        )
        .sort(
          (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
        )
        .map((m) => ({ ...m }));
    },
  };

  readonly tasks: TaskRepository = {
    listByProject: async (
      tenant: TenantContext,
      projectId: string,
    ): Promise<TaskEntity[]> => {
      return this.tasksList
        .filter(
          (t) =>
            t.organizationId === tenant.organizationId &&
            t.projectId === projectId,
        )
        .map((t) => ({ ...t }));
    },
  };

  readonly meetings: MeetingRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<MeetingEntity | null> => {
      const match = this.meetingsList.find(
        (m) => m.organizationId === tenant.organizationId && m.id === id,
      );
      return match ? { ...match } : null;
    },

    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<MeetingEntity[]> => {
      return this.meetingsList
        .filter(
          (m) =>
            m.organizationId === tenant.organizationId &&
            m.clientId === clientId,
        )
        .sort(
          (a, b) =>
            new Date(a.scheduledAt).getTime() -
            new Date(b.scheduledAt).getTime(),
        )
        .map((m) => ({ ...m }));
    },
  };

  readonly communications: CommunicationRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<CommunicationEntity[]> => {
      return this.communicationsList
        .filter(
          (c) =>
            c.organizationId === tenant.organizationId &&
            c.clientId === clientId,
        )
        .sort(
          (a, b) =>
            new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
        )
        .map((c) => ({ ...c }));
    },
  };

  readonly commitments: CommitmentRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<CommitmentEntity[]> => {
      return this.commitmentsList
        .filter(
          (c) =>
            c.organizationId === tenant.organizationId &&
            c.clientId === clientId,
        )
        .sort(
          (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
        )
        .map((c) => ({ ...c }));
    },
  };

  readonly decisions: DecisionRepository = {
    listByClient: async (
      tenant: TenantContext,
      clientId: string,
    ): Promise<DecisionEntity[]> => {
      return this.decisionsList
        .filter(
          (d) =>
            d.organizationId === tenant.organizationId &&
            d.clientId === clientId,
        )
        .sort(
          (a, b) =>
            new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime(),
        )
        .map((d) => ({ ...d }));
    },
  };

  readonly users: UserRepository = {
    findById: async (
      tenant: TenantContext,
      id: string,
    ): Promise<UserEntity | null> => {
      const match = this.usersList.find(
        (u) => u.organizationId === tenant.organizationId && u.id === id,
      );
      return match ? { ...match } : null;
    },

    list: async (tenant: TenantContext): Promise<UserEntity[]> => {
      return this.usersList
        .filter((u) => u.organizationId === tenant.organizationId)
        .map((u) => ({ ...u }));
    },
  };
}

export function createInMemoryDataStore(
  data?: SeedDataCollection,
): DataRepositories {
  return new InMemoryDataStore(data);
}
