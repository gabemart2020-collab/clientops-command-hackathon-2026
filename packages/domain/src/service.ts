import {
  EvidenceEntityTypeSchema,
  type AssessDeliveryHealthOutput,
  type Commitment,
  type GetAccountContextOutput,
  type ListOpenCommitmentsOutput,
  type PrepareBriefOutput,
  type RecentActivityOutput,
  type ActivityItem,
  type EvidenceRef,
} from '@clientops/contracts';
import type { Clock } from './clock.js';
import type { TenantContext } from './tenant.js';
import type { DataRepositories } from './repositories.js';
import { evaluateDeliveryHealth } from './rules/delivery-health.js';
import { deriveTalkingPoints } from './rules/talking-points.js';

export class ClientOpsService {
  constructor(
    private readonly repositories: DataRepositories,
    private readonly clock: Clock,
  ) {}

  async getAccountContext(
    tenant: TenantContext,
    accountRef: string,
  ): Promise<GetAccountContextOutput> {
    const client = await this.repositories.clients.findByRef(
      tenant,
      accountRef,
    );
    if (!client) {
      throw new Error(`Client not found for reference: "${accountRef}"`);
    }

    const projects = await this.repositories.projects.listByClient(
      tenant,
      client.id,
    );
    const activeProjects = projects.filter((p) => p.status === 'active');

    const meetings = await this.repositories.meetings.listByClient(
      tenant,
      client.id,
    );
    const nowEpoch = this.clock.now().getTime();
    const upcomingMeetings = meetings
      .filter((m) => new Date(m.scheduledAt).getTime() >= nowEpoch)
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
      );

    // Compute task and milestone counts across active projects
    let openTasks = 0;
    let completedTasks = 0;
    let openMilestones = 0;
    let overdueMilestones = 0;

    for (const project of activeProjects) {
      const milestones = await this.repositories.milestones.listByProject(
        tenant,
        project.id,
      );
      for (const m of milestones) {
        if (m.status !== 'completed' && m.status !== 'cancelled') {
          openMilestones++;
          if (new Date(m.dueAt).getTime() < nowEpoch) {
            overdueMilestones++;
          }
        }
      }

      const tasks = await this.repositories.tasks.listByProject(
        tenant,
        project.id,
      );
      for (const t of tasks) {
        if (t.status === 'completed') {
          completedTasks++;
        } else if (t.status !== 'cancelled') {
          openTasks++;
        }
      }
    }

    const commitments = await this.repositories.commitments.listByClient(
      tenant,
      client.id,
    );
    const openCommitmentEntities = commitments.filter(
      (c) => c.status === 'open',
    );

    const mappedOpenCommitments: Commitment[] = [];
    for (const c of openCommitmentEntities) {
      const owner = await this.repositories.users.findById(
        tenant,
        c.ownerUserId,
      );
      const originatingEvidence =
        await this.resolveCommitmentOriginatingEvidence(
          tenant,
          client.id,
          c.originatingEvidenceType,
          c.originatingEvidenceId,
        );
      mappedOpenCommitments.push({
        id: c.id,
        clientId: c.clientId,
        projectId: c.projectId,
        description: c.description,
        owner: {
          id: c.ownerUserId,
          name: owner?.name ?? 'Unassigned Operator',
          email: owner?.email ?? 'operator@example.com',
        },
        dueAt: c.dueAt,
        status: c.status,
        fulfilledAt: c.fulfilledAt,
        originatingEvidence,
      });
    }

    return {
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        industry: client.industry,
        tier: client.tier,
        createdAt: client.createdAt,
      },
      activeProjects: activeProjects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        targetCompletionAt: p.targetCompletionAt,
        leadUserId: p.leadUserId,
      })),
      upcomingMeetings: upcomingMeetings.map((m) => ({
        id: m.id,
        title: m.title,
        scheduledAt: m.scheduledAt,
        status: m.status,
        projectId: m.projectId,
      })),
      counts: {
        openTasks,
        completedTasks,
        openMilestones,
        overdueMilestones,
        openCommitments: openCommitmentEntities.length,
      },
      openCommitments: mappedOpenCommitments,
    };
  }

  async getRecentActivity(
    tenant: TenantContext,
    clientId: string,
    lookbackDays = 14,
  ): Promise<RecentActivityOutput> {
    const client = await this.repositories.clients.findById(tenant, clientId);
    if (!client) {
      throw new Error(`Client not found for ID: "${clientId}"`);
    }

    const nowEpoch = this.clock.now().getTime();
    const cutoffEpoch = nowEpoch - lookbackDays * 86400000;
    const items: ActivityItem[] = [];

    // 1. Communications
    const comms = await this.repositories.communications.listByClient(
      tenant,
      clientId,
    );
    for (const c of comms) {
      const commEpoch = new Date(c.occurredAt).getTime();
      if (commEpoch >= cutoffEpoch) {
        items.push({
          id: c.id,
          type: 'communication',
          title: c.subject,
          summary: c.summary,
          occurredAt: c.occurredAt,
          evidenceRef: {
            entityType: 'communication',
            entityId: c.id,
            field: 'summary',
            excerpt: c.summary,
          },
        });
      }
    }

    // 2. Completed tasks across client projects
    const projects = await this.repositories.projects.listByClient(
      tenant,
      clientId,
    );
    for (const project of projects) {
      const tasks = await this.repositories.tasks.listByProject(
        tenant,
        project.id,
      );
      for (const t of tasks) {
        if (t.status === 'completed' && t.completedAt) {
          const compEpoch = new Date(t.completedAt).getTime();
          if (compEpoch >= cutoffEpoch) {
            items.push({
              id: t.id,
              type: 'task_completed',
              title: t.title,
              summary: `Completed task in project "${project.name}"`,
              occurredAt: t.completedAt,
              evidenceRef: {
                entityType: 'task',
                entityId: t.id,
                field: 'title',
                excerpt: t.title,
              },
            });
          }
        }
      }
    }

    // 3. Past meetings
    const meetings = await this.repositories.meetings.listByClient(
      tenant,
      clientId,
    );
    for (const m of meetings) {
      const meetEpoch = new Date(m.scheduledAt).getTime();
      if (meetEpoch >= cutoffEpoch && meetEpoch <= nowEpoch) {
        items.push({
          id: m.id,
          type: 'meeting',
          title: m.title,
          summary: m.summary ?? `Conducted meeting "${m.title}"`,
          occurredAt: m.scheduledAt,
          evidenceRef: {
            entityType: 'meeting',
            entityId: m.id,
            field: m.summary ? 'summary' : 'title',
            excerpt: m.summary ?? m.title,
          },
        });
      }
    }

    // 4. Decisions
    const decisions = await this.repositories.decisions.listByClient(
      tenant,
      clientId,
    );
    for (const d of decisions) {
      const decEpoch = new Date(d.decidedAt).getTime();
      if (decEpoch >= cutoffEpoch) {
        items.push({
          id: d.id,
          type: 'decision',
          title: d.title,
          summary: d.rationale,
          occurredAt: d.decidedAt,
          evidenceRef: {
            entityType: 'decision',
            entityId: d.id,
            field: 'rationale',
            excerpt: d.rationale,
          },
        });
      }
    }

    // Stable sort: most recent first, with id as deterministic tiebreaker
    items.sort((a, b) => {
      const diff =
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });

    return {
      clientId,
      lookbackDays,
      items,
    };
  }

  async listOpenCommitments(
    tenant: TenantContext,
    clientId: string,
  ): Promise<ListOpenCommitmentsOutput> {
    const client = await this.repositories.clients.findById(tenant, clientId);
    if (!client) {
      throw new Error(`Client not found for ID: "${clientId}"`);
    }

    const commitments = await this.repositories.commitments.listByClient(
      tenant,
      clientId,
    );
    const openCommitments = commitments.filter((c) => c.status === 'open');

    const mapped: Commitment[] = [];
    for (const c of openCommitments) {
      const owner = await this.repositories.users.findById(
        tenant,
        c.ownerUserId,
      );
      const originatingEvidence =
        await this.resolveCommitmentOriginatingEvidence(
          tenant,
          clientId,
          c.originatingEvidenceType,
          c.originatingEvidenceId,
        );
      mapped.push({
        id: c.id,
        clientId: c.clientId,
        projectId: c.projectId,
        description: c.description,
        owner: {
          id: c.ownerUserId,
          name: owner?.name ?? 'Unassigned Operator',
          email: owner?.email ?? 'operator@example.com',
        },
        dueAt: c.dueAt,
        status: c.status,
        fulfilledAt: c.fulfilledAt,
        originatingEvidence,
      });
    }

    return {
      clientId,
      commitments: mapped,
    };
  }

  async assessDeliveryHealth(
    tenant: TenantContext,
    projectId: string,
  ): Promise<AssessDeliveryHealthOutput> {
    const project = await this.repositories.projects.findById(
      tenant,
      projectId,
    );
    if (!project) {
      throw new Error(`Project not found for ID: "${projectId}"`);
    }

    const milestones = await this.repositories.milestones.listByProject(
      tenant,
      projectId,
    );
    const tasks = await this.repositories.tasks.listByProject(
      tenant,
      projectId,
    );
    const communications = await this.repositories.communications.listByClient(
      tenant,
      project.clientId,
    );
    const commitments = await this.repositories.commitments.listByClient(
      tenant,
      project.clientId,
    );

    return evaluateDeliveryHealth({
      projectId,
      clientId: project.clientId,
      milestones,
      tasks,
      communications,
      commitments,
      evaluationTime: this.clock.now(),
    });
  }

  async prepareBrief(
    tenant: TenantContext,
    meetingId: string,
  ): Promise<PrepareBriefOutput> {
    const meeting = await this.repositories.meetings.findById(
      tenant,
      meetingId,
    );
    if (!meeting) {
      throw new Error(`Meeting not found for ID: "${meetingId}"`);
    }

    const client = await this.repositories.clients.findById(
      tenant,
      meeting.clientId,
    );
    if (!client) {
      throw new Error(`Client not found for meeting: "${meeting.clientId}"`);
    }

    // Determine relevant project for health assessment
    let targetProjectId = meeting.projectId;
    if (!targetProjectId) {
      const clientProjects = await this.repositories.projects.listByClient(
        tenant,
        client.id,
      );
      targetProjectId = clientProjects.find((p) => p.status === 'active')?.id;
    }

    let projectStatus: AssessDeliveryHealthOutput | undefined;
    let projectEntity;
    if (targetProjectId) {
      projectStatus = await this.assessDeliveryHealth(tenant, targetProjectId);
      projectEntity = await this.repositories.projects.findById(
        tenant,
        targetProjectId,
      );
    }

    const recentActivity = await this.getRecentActivity(tenant, client.id, 14);
    const openCommitments = await this.listOpenCommitments(tenant, client.id);

    // Count completed tasks
    const completedTasksCount = recentActivity.items.filter(
      (i: ActivityItem) => i.type === 'task_completed',
    ).length;

    // Fetch open commitment entities for talking point derivation
    const rawCommitments = await this.repositories.commitments.listByClient(
      tenant,
      client.id,
    );
    const rawOpenCommitments = rawCommitments.filter(
      (c) => c.status === 'open',
    );

    const talkingPoints = deriveTalkingPoints({
      meeting,
      project: projectEntity ?? undefined,
      healthResult: projectStatus,
      openCommitments: rawOpenCommitments,
      completedTasksCount,
      evaluationTime: this.clock.now(),
    });

    // Consolidate evidence
    const evidenceList: EvidenceRef[] = [];
    if (projectStatus) {
      evidenceList.push(...projectStatus.evidence);
    }
    for (const item of recentActivity.items) {
      evidenceList.push(item.evidenceRef);
    }
    for (const commitment of openCommitments.commitments) {
      if (commitment.originatingEvidence) {
        evidenceList.push(commitment.originatingEvidence);
      }
    }

    return {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        scheduledAt: meeting.scheduledAt,
        status: meeting.status,
        summary: meeting.summary,
      },
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        industry: client.industry,
        tier: client.tier,
        createdAt: client.createdAt,
      },
      projectStatus,
      recentActivity: recentActivity.items,
      openCommitments: openCommitments.commitments,
      riskFindings: projectStatus ? projectStatus.findings : [],
      talkingPoints,
      evidence: evidenceList,
    };
  }

  private async resolveCommitmentOriginatingEvidence(
    tenant: TenantContext,
    clientId: string,
    originatingType?: string,
    originatingId?: string,
  ): Promise<EvidenceRef | undefined> {
    if (!originatingType || !originatingId) {
      return undefined;
    }
    const typeParsed = EvidenceEntityTypeSchema.safeParse(originatingType);
    if (!typeParsed.success) {
      return undefined;
    }
    const entityType = typeParsed.data;

    if (entityType === 'meeting') {
      const meeting = await this.repositories.meetings.findById(
        tenant,
        originatingId,
      );
      if (meeting) {
        return {
          entityType: 'meeting',
          entityId: originatingId,
          field: meeting.summary ? 'summary' : 'title',
          excerpt: meeting.summary ?? meeting.title,
        };
      }
    } else if (entityType === 'communication') {
      const comms = await this.repositories.communications.listByClient(
        tenant,
        clientId,
      );
      const comm = comms.find((item) => item.id === originatingId);
      if (comm) {
        return {
          entityType: 'communication',
          entityId: originatingId,
          field: 'summary',
          excerpt: comm.summary,
        };
      }
    } else if (entityType === 'decision') {
      const decisions = await this.repositories.decisions.listByClient(
        tenant,
        clientId,
      );
      const decision = decisions.find((item) => item.id === originatingId);
      if (decision) {
        return {
          entityType: 'decision',
          entityId: originatingId,
          field: 'rationale',
          excerpt: decision.rationale,
        };
      }
    }

    return {
      entityType,
      entityId: originatingId,
    };
  }
}
