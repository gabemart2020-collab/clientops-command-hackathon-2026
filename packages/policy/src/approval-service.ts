import { randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  ApprovalRecord,
  ActionStatus,
} from '@clientops/contracts';
import {
  ApprovalDecisionRequestSchema,
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
} from '@clientops/contracts';
import type {
  TenantContext,
  ActionProposalRepository,
  ActionApprovalRepository,
  AuditEventRepository,
  UserRepository,
  UserEntity,
  ClientRepository,
  ProjectRepository,
  MilestoneRepository,
  RepositoryTransactionOptions,
  Clock,
} from '@clientops/domain';
import { SystemClock } from '@clientops/domain';
import { buildAuditEvent, sanitizeApprovalComment } from '@clientops/audit';
import type { TrustedActorContext } from '@clientops/contracts';
import type { TransactionRunner } from './proposal-service.js';

export const DEFAULT_APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_APPROVAL_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class ProposalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalExpiredError';
  }
}

export class UnauthorizedApproverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedApproverError';
  }
}

export class ProposalTamperedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalTamperedError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class InvalidProposalStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProposalStatusError';
  }
}

export interface ApprovalResolutionRepositories {
  actionProposalRepository: ActionProposalRepository;
  actionApprovalRepository: ActionApprovalRepository;
  auditEventRepository: AuditEventRepository;
  userRepository: UserRepository;
  clientRepository?: ClientRepository;
  projectRepository?: ProjectRepository;
}

export interface ResolveApprovalDecisionParams {
  tenant: TenantContext;
  proposalId: string;
  request: unknown;
  actor: TrustedActorContext;
  repositories: ApprovalResolutionRepositories;
  transactionRunner: TransactionRunner;
  clock?: Clock;
  validityDurationMs?: number;
  txOptions?: RepositoryTransactionOptions;
}

export interface ResolveApprovalDecisionResult {
  proposal: ActionProposal;
  approval: ApprovalRecord;
  idempotent: boolean;
}

/**
 * Asserts that the actor exists in the authoritative user repository for the tenant,
 * belongs to the tenant organization, has role 'admin' or 'operator', and
 * matches the actor's stated role.
 *
 * Throws UnauthorizedApproverError if any condition is violated.
 */
export async function assertAuthoritativeApproverRole(
  tenant: TenantContext,
  actor: TrustedActorContext,
  userRepository: UserRepository,
): Promise<UserEntity> {
  const user = await userRepository.findById(tenant, actor.actorId);
  if (!user) {
    throw new UnauthorizedApproverError(
      `Actor '${actor.actorId}' does not exist in tenant '${tenant.organizationId}'.`,
    );
  }
  if (user.organizationId !== tenant.organizationId) {
    throw new UnauthorizedApproverError(
      `User organization '${user.organizationId}' does not match tenant '${tenant.organizationId}'.`,
    );
  }
  if (user.role !== 'admin' && user.role !== 'operator') {
    throw new UnauthorizedApproverError(
      `User '${user.id}' with role '${user.role}' is not authorized to review or approve actions (requires admin or operator).`,
    );
  }
  if (user.role !== actor.role) {
    throw new UnauthorizedApproverError(
      `Actor role '${actor.role}' does not match authoritative database user role '${user.role}'. Potential role escalation.`,
    );
  }
  return user;
}

/**
 * Resolves a human APPROVE or DENY decision atomically.
 *
 * Enforces the strict 17-step approval transaction:
 * 1. resolve trusted server TenantContext
 * 2. resolve TrustedActorContext server-side
 * 3. SELECT target proposal FOR UPDATE
 * 4. require same tenant
 * 5. require status PENDING_APPROVAL (or idempotent match)
 * 6. require proposal not expired using server clock
 * 7. verify trusted actor tenant matches proposal
 * 8. verify authoritative database user:
 *    - same actor id
 *    - same tenant
 *    - admin/operator
 *    - role matches TrustedActorContext
 * 9. recompute proposal parameterHash
 * 10. recompute approvalBindingHash
 * 11. verify both against durable proposal
 * 12. choose server decidedAt
 * 13. derive server validUntil such that: decidedAt < validUntil <= proposal.expiresAt
 * 14. insert immutable ApprovalRecord
 * 15. if APPROVE: transition PENDING_APPROVAL -> APPROVED
 *     if DENY: transition PENDING_APPROVAL -> DENIED
 * 16. append ACTION_APPROVED or ACTION_DENIED
 * 17. COMMIT
 *
 * ZERO task mutation.
 * ZERO execution rows.
 * ZERO WRITE MCP invocations.
 */
export async function resolveApprovalDecision(
  params: ResolveApprovalDecisionParams,
): Promise<ResolveApprovalDecisionResult> {
  const clock = params.clock ?? new SystemClock();
  const { tenant, proposalId, actor, repositories } = params;

  // Validate the decision request strictly
  const parseResult = ApprovalDecisionRequestSchema.safeParse(params.request);
  if (!parseResult.success) {
    throw new Error(
      `Invalid approval decision request: ${parseResult.error.message}`,
    );
  }
  const validatedRequest = parseResult.data;

  // Sanitize untrusted approval comment
  const sanitizedComment = sanitizeApprovalComment(validatedRequest.comment);

  const validityDurationMs =
    params.validityDurationMs ?? DEFAULT_APPROVAL_VALIDITY_MS;
  if (
    typeof validityDurationMs !== 'number' ||
    !Number.isFinite(validityDurationMs) ||
    validityDurationMs <= 0 ||
    validityDurationMs > MAX_APPROVAL_VALIDITY_MS
  ) {
    throw new Error(
      `Invalid approval validity duration: '${validityDurationMs}'. Validity must be a finite positive number not exceeding ${MAX_APPROVAL_VALIDITY_MS} ms.`,
    );
  }

  if (
    !params.transactionRunner ||
    typeof params.transactionRunner !== 'function'
  ) {
    throw new Error(
      'A mandatory TransactionRunner must be provided to resolveApprovalDecision.',
    );
  }

  return await params.transactionRunner(async (txOpts) => {
    // 3. SELECT target proposal FOR UPDATE
    const proposal = await repositories.actionProposalRepository.findById(
      tenant,
      proposalId,
      { ...txOpts, forUpdate: true },
    );

    if (!proposal) {
      throw new ProposalNotFoundError(
        `Action proposal '${proposalId}' not found in tenant '${tenant.organizationId}'.`,
      );
    }

    // 4. Require same tenant
    if (proposal.organizationId !== tenant.organizationId) {
      throw new ProposalNotFoundError(
        `Action proposal '${proposalId}' not found in tenant '${tenant.organizationId}'.`,
      );
    }

    // 5. Verify trusted actor tenant matches proposal (BEFORE IDEMPOTENCY)
    if (actor.organizationId !== proposal.organizationId) {
      throw new UnauthorizedApproverError(
        `Actor tenant '${actor.organizationId}' does not match proposal tenant '${proposal.organizationId}'.`,
      );
    }

    // 6. Verify authoritative database user (BEFORE IDEMPOTENCY)
    await assertAuthoritativeApproverRole(
      tenant,
      actor,
      repositories.userRepository,
    );

    // 7. Idempotency check: if proposal already resolved
    if (
      proposal.status === 'APPROVED' ||
      proposal.status === 'DENIED' ||
      proposal.status === 'EXECUTING' ||
      proposal.status === 'COMPLETED' ||
      proposal.status === 'FAILED'
    ) {
      const existingApproval =
        await repositories.actionApprovalRepository.findByProposalId(
          tenant,
          proposalId,
          txOpts,
        );

      if (existingApproval) {
        if (existingApproval.decision === validatedRequest.decision) {
          // Idempotent retry: same decision returns existing record
          return {
            proposal,
            approval: existingApproval,
            idempotent: true,
          };
        }
        // Opposite decision: throw conflict (terminal decision cannot change)
        throw new ConflictError(
          `Cannot change immutable decision from '${existingApproval.decision}' to '${validatedRequest.decision}'. Proposal '${proposalId}' is already resolved.`,
        );
      }
      throw new ConflictError(
        `Action proposal '${proposalId}' is already resolved with status '${proposal.status}'.`,
      );
    }

    // 8. Require status PENDING_APPROVAL
    if (proposal.status !== 'PENDING_APPROVAL') {
      throw new InvalidProposalStatusError(
        `Action proposal '${proposalId}' is in status '${proposal.status}'. Only proposals in 'PENDING_APPROVAL' status can be resolved.`,
      );
    }

    // 9. Single captured clock instant for decision and expiration checks
    const decidedAtDate = clock.now();
    const decidedAtMs = decidedAtDate.getTime();
    const decidedAt = decidedAtDate.toISOString();
    const expiresAtMs = new Date(proposal.expiresAt).getTime();

    // 10. Require proposal not expired using server clock
    if (decidedAtMs >= expiresAtMs) {
      throw new ProposalExpiredError(
        `Action proposal '${proposalId}' has expired at ${proposal.expiresAt}. Decision rejected.`,
      );
    }

    // 11. Recompute proposal parameterHash
    const expectedParamHash = computeCanonicalParameterHash(
      proposal.parameters,
    );
    if (expectedParamHash !== proposal.parameterHash) {
      throw new ProposalTamperedError(
        `Durable proposal parameterHash '${proposal.parameterHash}' does not match recomputed parameterHash '${expectedParamHash}'. Tampering detected.`,
      );
    }

    // 12. Recompute approvalBindingHash
    const expectedBindingHash = computeApprovalBindingHash({
      organizationId: proposal.organizationId,
      actionType: proposal.actionType,
      parameters: proposal.parameters,
      preconditions: proposal.preconditions,
      expiresAt: proposal.expiresAt,
    });
    if (expectedBindingHash !== proposal.approvalBindingHash) {
      throw new ProposalTamperedError(
        `Durable proposal approvalBindingHash '${proposal.approvalBindingHash}' does not match recomputed approvalBindingHash '${expectedBindingHash}'. Tampering detected.`,
      );
    }

    // 13. Derive server validUntil such that: decidedAt < validUntil <= proposal.expiresAt
    const nominalValidUntilMs = decidedAtMs + validityDurationMs;
    const validUntilMs = Math.min(nominalValidUntilMs, expiresAtMs);
    if (validUntilMs <= decidedAtMs) {
      throw new ProposalExpiredError(
        `Action proposal '${proposalId}' expires at or before decision time. Cannot create valid approval.`,
      );
    }
    const validUntil = new Date(validUntilMs).toISOString();

    // 14. Insert immutable ApprovalRecord
    const approvalRecord: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: proposal.id,
      organizationId: tenant.organizationId,
      actorId: actor.actorId,
      actorRole: actor.role as 'admin' | 'operator',
      decision: validatedRequest.decision,
      decidedAt,
      parameterHash: proposal.parameterHash,
      approvalBindingHash: proposal.approvalBindingHash,
      validUntil,
      ...(sanitizedComment ? { comment: sanitizedComment } : {}),
    };

    try {
      await repositories.actionApprovalRepository.create(
        approvalRecord,
        txOpts,
      );
    } catch (createErr) {
      // If a concurrent resolution occurred, check if the existing approval matches idempotently
      const existing =
        await repositories.actionApprovalRepository.findByProposalId(
          tenant,
          proposal.id,
          txOpts,
        );
      if (existing) {
        if (existing.decision === validatedRequest.decision) {
          const currentProposal =
            (await repositories.actionProposalRepository.findById(
              tenant,
              proposal.id,
              txOpts,
            )) ?? proposal;
          return {
            proposal: currentProposal,
            approval: existing,
            idempotent: true,
          };
        }
        throw new ConflictError(
          `Cannot change immutable decision from '${existing.decision}' to '${validatedRequest.decision}'. Proposal '${proposal.id}' is already resolved.`,
        );
      }
      throw createErr;
    }

    let updatedProposal: ActionProposal;

    if (validatedRequest.decision === 'APPROVE') {
      // 15a. Transition PENDING_APPROVAL -> APPROVED
      updatedProposal =
        await repositories.actionProposalRepository.transitionStatus(
          tenant,
          proposal.id,
          'PENDING_APPROVAL',
          'APPROVED',
          txOpts,
        );

      // 16a. Append ACTION_APPROVED audit event
      const approvedEvent = buildAuditEvent({
        eventType: 'ACTION_APPROVED',
        organizationId: tenant.organizationId,
        actionProposalId: proposal.id,
        actorId: actor.actorId,
        approvalBindingHash: proposal.approvalBindingHash,
        occurredAt: decidedAt,
        payload: {
          actionProposalId: proposal.id,
          actorId: actor.actorId,
          actorRole: actor.role as 'admin' | 'operator',
          decidedAt,
          approvalBindingHash: proposal.approvalBindingHash,
          ...(sanitizedComment ? { comment: sanitizedComment } : {}),
        },
      });
      await repositories.auditEventRepository.append(approvedEvent, txOpts);
    } else {
      // 15b. Transition PENDING_APPROVAL -> DENIED
      updatedProposal =
        await repositories.actionProposalRepository.transitionStatus(
          tenant,
          proposal.id,
          'PENDING_APPROVAL',
          'DENIED',
          txOpts,
        );

      // 16b. Append ACTION_DENIED audit event
      const deniedEvent = buildAuditEvent({
        eventType: 'ACTION_DENIED',
        organizationId: tenant.organizationId,
        actionProposalId: proposal.id,
        actorId: actor.actorId,
        occurredAt: decidedAt,
        payload: {
          actionProposalId: proposal.id,
          actorId: actor.actorId,
          actorRole: actor.role as 'admin' | 'operator',
          decidedAt,
          reason: sanitizedComment ?? 'Denied by human approver.',
        },
      });
      await repositories.auditEventRepository.append(deniedEvent, txOpts);
    }

    return {
      proposal: updatedProposal,
      approval: approvalRecord,
      idempotent: false,
    };
  });
}

export interface ProposalReviewDetail {
  id: string;
  actionType: string;
  actionClass: string;
  status: ActionStatus;
  client: {
    id: string;
    name: string;
    tier: string;
  };
  project: {
    id: string;
    name: string;
    status: string;
  };
  task: {
    title: string;
    description?: string | undefined;
    priority: string;
    dueAt?: string | undefined;
    assigneeUserId?: string | undefined;
    assigneeDisplayName?: string | undefined;
    milestoneId?: string | undefined;
    milestoneTitle?: string | undefined;
  };
  justification: string;
  evidence: Array<{
    entityType: string;
    entityId: string;
    field?: string | undefined;
    excerpt?: string | undefined;
  }>;
  createdAt: string;
  expiresAt: string;
}

/**
 * Trusted server read/inspection boundary.
 * Returns frozen proposal details for human review before deciding.
 * Strictly tenant-scoped; omits internal hashes and raw model prompts.
 */
export async function getProposalForReview(
  tenant: TenantContext,
  proposalId: string,
  repositories: {
    actionProposalRepository: ActionProposalRepository;
    clientRepository: ClientRepository;
    projectRepository: ProjectRepository;
    userRepository?: UserRepository;
    milestoneRepository?: MilestoneRepository;
  },
): Promise<ProposalReviewDetail | null> {
  const proposal = await repositories.actionProposalRepository.findById(
    tenant,
    proposalId,
  );
  if (!proposal || proposal.organizationId !== tenant.organizationId) {
    return null;
  }

  const client = await repositories.clientRepository.findById(
    tenant,
    proposal.parameters.clientId,
  );
  const project = await repositories.projectRepository.findById(
    tenant,
    proposal.parameters.projectId,
  );

  let milestoneTitle: string | undefined = undefined;
  if (proposal.parameters.milestoneId && repositories.milestoneRepository) {
    const milestone = await repositories.milestoneRepository.findById(
      tenant,
      proposal.parameters.milestoneId,
    );
    if (milestone) {
      milestoneTitle = milestone.title;
    }
  }

  let assigneeDisplayName: string | undefined =
    proposal.parameters.assigneeDisplayName;
  if (proposal.parameters.assigneeUserId && repositories.userRepository) {
    const user = await repositories.userRepository.findById(
      tenant,
      proposal.parameters.assigneeUserId,
    );
    if (user) {
      assigneeDisplayName = user.name;
    }
  }

  return {
    id: proposal.id,
    actionType: proposal.actionType,
    actionClass: proposal.actionClass,
    status: proposal.status,
    client: {
      id: client?.id ?? proposal.parameters.clientId,
      name: client?.name ?? 'Unknown Client',
      tier: client?.tier ?? 'standard',
    },
    project: {
      id: project?.id ?? proposal.parameters.projectId,
      name: project?.name ?? 'Unknown Project',
      status: project?.status ?? 'active',
    },
    task: {
      title: proposal.parameters.title,
      description: proposal.parameters.description,
      priority: proposal.parameters.priority,
      dueAt: proposal.parameters.dueAt,
      assigneeUserId: proposal.parameters.assigneeUserId,
      assigneeDisplayName,
      milestoneId: proposal.parameters.milestoneId,
      milestoneTitle,
    },
    justification: proposal.justification,
    evidence: proposal.evidence.map((e) => ({
      entityType: e.entityType,
      entityId: e.entityId,
      field: e.field,
      excerpt: e.excerpt,
    })),
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  };
}
