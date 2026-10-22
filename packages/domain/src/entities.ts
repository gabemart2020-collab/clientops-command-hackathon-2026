export interface OrganizationEntity {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserEntity {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientEntity {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  industry: string;
  tier: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEntity {
  id: string;
  organizationId: string;
  clientId: string;
  name: string;
  status: string; // 'active' | 'paused' | 'completed'
  leadUserId?: string | undefined;
  targetCompletionAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneEntity {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  status: string; // 'open' | 'in_progress' | 'completed' | 'cancelled'
  dueAt: string;
  completedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEntity {
  id: string;
  organizationId: string;
  projectId: string;
  milestoneId?: string | undefined;
  title: string;
  description?: string | undefined;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | undefined;
  status: string; // 'open' | 'in_progress' | 'completed' | 'cancelled'
  assigneeUserId?: string | undefined;
  dueAt?: string | undefined;
  completedAt?: string | undefined;
  sourceActionProposalId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingEntity {
  id: string;
  organizationId: string;
  clientId: string;
  projectId?: string | undefined;
  title: string;
  scheduledAt: string;
  status: string; // 'scheduled' | 'completed' | 'cancelled'
  summary?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationEntity {
  id: string;
  organizationId: string;
  clientId: string;
  channel: string; // 'email' | 'call' | 'ticket' | 'note'
  subject: string;
  summary: string;
  occurredAt: string;
  requiresResponse: boolean;
  resolvedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentEntity {
  id: string;
  organizationId: string;
  clientId: string;
  projectId?: string | undefined;
  description: string;
  ownerUserId: string;
  dueAt: string;
  status: 'open' | 'fulfilled' | 'cancelled';
  fulfilledAt?: string | undefined;
  originatingEvidenceType?: string | undefined;
  originatingEvidenceId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionEntity {
  id: string;
  organizationId: string;
  clientId: string;
  projectId?: string | undefined;
  title: string;
  rationale: string;
  decidedAt: string;
  decidedByUserId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}
