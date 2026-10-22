import { randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  CreateActionProposalInput,
  RecordVersionPrecondition,
} from '@clientops/contracts';
import {
  ModelActionProposalInputSchema,
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
  materializeTaskCreateParameters,
} from '@clientops/contracts';
import type {
  TenantContext,
  ClientRepository,
  ProjectRepository,
  ActionProposalRepository,
  AuditEventRepository,
  UserRepository,
  MilestoneRepository,
  RepositoryTransactionOptions,
  Clock,
} from '@clientops/domain';
import { SystemClock } from '@clientops/domain';
import { buildAuditEvent } from '@clientops/audit';
import { evaluatePolicy } from './policy.js';
import {
  resolveProposalEvidence,
  type AuthoritativeEvidenceResolver,
} from './evidence-resolver.js';

/**
 * Default proposal time-to-live (TTL) window: 24 hours.
 * Server-owned constant; untrusted clients cannot specify expiration.
 */
export const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum proposal time-to-live (TTL) window: 30 days.
 */
export const MAX_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProposalRegistrationRepositories {
  clientRepository: ClientRepository;
  projectRepository: ProjectRepository;
  actionProposalRepository: ActionProposalRepository;
  auditEventRepository: AuditEventRepository;
  userRepository: UserRepository;
  milestoneRepository: MilestoneRepository;
}

export type TransactionRunner = <T>(
  fn: (txOptions: RepositoryTransactionOptions) => Promise<T>,
) => Promise<T>;

export interface RegisterActionProposalParams {
  tenant: TenantContext;
  modelInput: unknown;
  correlationId: string;
  evidenceResolver: AuthoritativeEvidenceResolver;
  repositories: ProposalRegistrationRepositories;
  transactionRunner: TransactionRunner;
  clock?: Clock;
  ttlMs?: number;
  txOptions?: RepositoryTransactionOptions;
}

const PROPOSAL_CORRELATION_CONSTRAINT = 'uq_action_proposals_org_correlation';

function isCorrelationUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === '23505' &&
    candidate.constraint === PROPOSAL_CORRELATION_CONSTRAINT
  );
}

export class ProposalRegistrationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'PROPOSAL_REGISTRATION_FAILED',
  ) {
    super(message);
    this.name = 'ProposalRegistrationError';
  }
}

/**
 * Trusted server-side proposal registration service for task.create.
 *
 * Enforces the strict 19-step registration lifecycle:
 * 1. Parse ModelActionProposalInput strictly.
 * 2. evaluatePolicy(actionType).
 * 3. Require: decision == REQUIRES_APPROVAL, actionClass == WRITE, actionType == task.create.
 * 4. Materialize TaskCreateParameters defaults.
 * 5. Resolve model citations through the Phase 3 authoritative evidence registry.
 * 6. Load target client/project under trusted tenant.
 * 7. Verify:
 *    - client exists in tenant;
 *    - project exists in tenant;
 *    - project belongs to parameters.clientId;
 *    - project is an allowed current target.
 * 8. Derive RecordVersionPrecondition from authoritative target project.updated_at.
 * 9. Compute canonical parameterHash.
 * 10. Compute approvalBindingHash.
 * 11. Generate server UUID.
 * 12. Generate server createdAt.
 * 13. Derive expiresAt from a bounded server policy/configuration.
 * 14. Construct CreateActionProposalInput with status PROPOSED.
 * 15. Persist proposal (status PROPOSED).
 * 16. Append ACTION_PROPOSED.
 * 17. Transition PROPOSED -> PENDING_APPROVAL.
 * 18. Append APPROVAL_REQUESTED.
 * 19. COMMIT (atomic transaction; rollback on any failure).
 */
export async function registerActionProposal(
  params: RegisterActionProposalParams,
): Promise<ActionProposal> {
  const clock = params.clock ?? new SystemClock();
  const { tenant, repositories, evidenceResolver } = params;

  if (!params.correlationId.trim()) {
    throw new ProposalRegistrationError(
      'Proposal correlationId must be a non-empty trusted request identifier.',
      'INVALID_CORRELATION_ID',
    );
  }

  const existingProposal =
    await repositories.actionProposalRepository.findByCorrelationId(
      tenant,
      params.correlationId,
    );
  if (existingProposal) {
    return existingProposal;
  }

  // 1. Parse ModelActionProposalInput strictly
  const parseResult = ModelActionProposalInputSchema.safeParse(
    params.modelInput,
  );
  if (!parseResult.success) {
    throw new ProposalRegistrationError(
      `Invalid model action proposal: ${parseResult.error.message}`,
      'INVALID_MODEL_PROPOSAL',
    );
  }
  const validatedInput = parseResult.data;

  // 2. evaluatePolicy(actionType)
  const policy = evaluatePolicy(validatedInput.actionType);

  // 3. Require policy requires approval, is WRITE, and actionType is task.create
  if (
    policy.decision !== 'REQUIRES_APPROVAL' ||
    policy.actionClass !== 'WRITE' ||
    validatedInput.actionType !== 'task.create'
  ) {
    throw new ProposalRegistrationError(
      `Policy rejected action proposal: decision '${policy.decision}', class '${policy.actionClass}', type '${validatedInput.actionType}'. Only 'task.create' with REQUIRES_APPROVAL is allowed.`,
      'POLICY_REJECTED',
    );
  }

  // 4. Materialize TaskCreateParameters defaults
  const canonicalParams = materializeTaskCreateParameters(
    validatedInput.parameters,
  );

  // 4b. Authoritative assignee binding validation & hydration
  if (
    validatedInput.parameters.assigneeDisplayName &&
    !validatedInput.parameters.assigneeUserId
  ) {
    throw new ProposalRegistrationError(
      'Assignee display name provided without authoritative assigneeUserId. Untrusted display-only assignees are prohibited.',
      'UNTRUSTED_ASSIGNEE',
    );
  }

  if (canonicalParams.assigneeUserId) {
    if (!repositories.userRepository) {
      throw new ProposalRegistrationError(
        'UserRepository is required for proposal registration when assigneeUserId is supplied.',
        'USER_REPOSITORY_REQUIRED',
      );
    }
    const assigneeUser = await repositories.userRepository.findById(
      tenant,
      canonicalParams.assigneeUserId,
    );
    if (!assigneeUser) {
      throw new ProposalRegistrationError(
        `Assignee user '${canonicalParams.assigneeUserId}' not found in tenant '${tenant.organizationId}'.`,
        'ASSIGNEE_NOT_FOUND',
      );
    }
    if (assigneeUser.organizationId !== tenant.organizationId) {
      throw new ProposalRegistrationError(
        `Assignee user '${canonicalParams.assigneeUserId}' belongs to '${assigneeUser.organizationId}', not '${tenant.organizationId}'.`,
        'TENANT_MISMATCH',
      );
    }

    if (validatedInput.parameters.assigneeDisplayName) {
      const normalizeName = (s: string) =>
        s.trim().toLowerCase().replace(/\s+/g, ' ');
      if (
        normalizeName(validatedInput.parameters.assigneeDisplayName) !==
        normalizeName(assigneeUser.name)
      ) {
        throw new ProposalRegistrationError(
          `Assignee display name '${validatedInput.parameters.assigneeDisplayName}' does not match authoritative user name '${assigneeUser.name}'.`,
          'ASSIGNEE_NAME_MISMATCH',
        );
      }
    }

    // Hydrate authoritative display name before hashes are computed
    canonicalParams.assigneeDisplayName = assigneeUser.name;
  }

  // 5. Resolve model citations through authoritative evidence resolver
  const hydratedEvidence = resolveProposalEvidence(
    validatedInput.citations,
    evidenceResolver,
  );

  // 6. Load target client/project under trusted tenant
  const client = await repositories.clientRepository.findById(
    tenant,
    canonicalParams.clientId,
  );
  if (!client) {
    throw new ProposalRegistrationError(
      `Client '${canonicalParams.clientId}' not found in tenant '${tenant.organizationId}'.`,
      'CLIENT_NOT_FOUND',
    );
  }
  if (client.organizationId !== tenant.organizationId) {
    throw new ProposalRegistrationError(
      `Client tenant mismatch: client '${client.id}' belongs to '${client.organizationId}', not '${tenant.organizationId}'.`,
      'TENANT_MISMATCH',
    );
  }

  const project = await repositories.projectRepository.findById(
    tenant,
    canonicalParams.projectId,
  );
  if (!project) {
    throw new ProposalRegistrationError(
      `Project '${canonicalParams.projectId}' not found in tenant '${tenant.organizationId}'.`,
      'PROJECT_NOT_FOUND',
    );
  }
  if (project.organizationId !== tenant.organizationId) {
    throw new ProposalRegistrationError(
      `Project tenant mismatch: project '${project.id}' belongs to '${project.organizationId}', not '${tenant.organizationId}'.`,
      'TENANT_MISMATCH',
    );
  }

  // 7. Verify project belongs to parameters.clientId and is an allowed target
  if (project.clientId !== client.id) {
    throw new ProposalRegistrationError(
      `Project '${project.id}' belongs to client '${project.clientId}', not '${client.id}'.`,
      'RELATIONSHIP_MISMATCH',
    );
  }
  if (project.status === 'completed' || project.status === 'cancelled') {
    throw new ProposalRegistrationError(
      `Project '${project.id}' is in status '${project.status}' and cannot receive new tasks.`,
      'PROJECT_STATUS_INVALID',
    );
  }

  // 7b. Milestone authoritative validation
  if (canonicalParams.milestoneId) {
    if (!repositories.milestoneRepository) {
      throw new ProposalRegistrationError(
        'MilestoneRepository is required for proposal registration when milestoneId is supplied.',
        'MILESTONE_REPOSITORY_REQUIRED',
      );
    }
    const milestone = await repositories.milestoneRepository.findById(
      tenant,
      canonicalParams.milestoneId,
    );
    if (!milestone) {
      throw new ProposalRegistrationError(
        `Milestone '${canonicalParams.milestoneId}' not found in tenant '${tenant.organizationId}'.`,
        'MILESTONE_NOT_FOUND',
      );
    }
    if (milestone.projectId !== project.id) {
      throw new ProposalRegistrationError(
        `Milestone '${milestone.id}' belongs to project '${milestone.projectId}', not target project '${project.id}'.`,
        'MILESTONE_PROJECT_MISMATCH',
      );
    }
  }

  // 8. Derive RecordVersionPrecondition from authoritative target project.updated_at
  const preconditions: RecordVersionPrecondition[] = [
    {
      entityType: 'project',
      entityId: project.id,
      versionField: 'updated_at',
      expectedValue: project.updatedAt,
    },
  ];

  // 9. Compute canonical parameterHash
  const parameterHash = computeCanonicalParameterHash(canonicalParams);

  // 11. Generate server UUID
  const proposalId = randomUUID();

  // 12. Generate server createdAt
  const now = clock.now();
  const createdAt = now.toISOString();

  // 13. Derive expiresAt from bounded server policy
  const ttlMs = params.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  if (
    typeof ttlMs !== 'number' ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_PROPOSAL_TTL_MS
  ) {
    throw new ProposalRegistrationError(
      `Invalid proposal TTL: '${ttlMs}'. Proposal TTL must be a finite positive number not exceeding ${MAX_PROPOSAL_TTL_MS} ms.`,
      'INVALID_TTL',
    );
  }
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  // 10. Compute approvalBindingHash
  const approvalBindingHash = computeApprovalBindingHash({
    organizationId: tenant.organizationId,
    actionType: validatedInput.actionType,
    parameters: canonicalParams,
    preconditions,
    expiresAt,
  });

  // 14. Construct CreateActionProposalInput with status PROPOSED
  const proposalInput: CreateActionProposalInput = {
    id: proposalId,
    organizationId: tenant.organizationId,
    actionType: 'task.create',
    actionClass: 'WRITE',
    parameters: canonicalParams,
    parameterHash,
    approvalBindingHash,
    correlationId: params.correlationId,
    evidence: hydratedEvidence,
    preconditions,
    status: 'PROPOSED',
    justification: validatedInput.justification,
    createdAt,
    expiresAt,
  };

  // Steps 15-18: Execute inside an atomic transaction
  if (
    !params.transactionRunner ||
    typeof params.transactionRunner !== 'function'
  ) {
    throw new ProposalRegistrationError(
      'A mandatory TransactionRunner must be provided to registerActionProposal.',
      'TRANSACTION_RUNNER_REQUIRED',
    );
  }

  try {
    return await params.transactionRunner(async (txOpts) => {
      // 15. Persist proposal
      await repositories.actionProposalRepository.create(proposalInput, txOpts);

      // 16. Append ACTION_PROPOSED audit event
      const proposedEvent = buildAuditEvent({
        eventType: 'ACTION_PROPOSED',
        organizationId: tenant.organizationId,
        actionProposalId: proposalId,
        parameterHash,
        approvalBindingHash,
        correlationId: params.correlationId,
        occurredAt: createdAt,
        payload: {
          actionProposalId: proposalId,
          actionType: 'task.create',
          actionClass: 'WRITE',
          parameterHash,
          approvalBindingHash,
          justification: validatedInput.justification,
          clientId: canonicalParams.clientId,
          projectId: canonicalParams.projectId,
          preconditionCount: preconditions.length,
          citationCount: hydratedEvidence.length,
        },
      });
      await repositories.auditEventRepository.append(proposedEvent, txOpts);

      // 17. Transition PROPOSED -> PENDING_APPROVAL
      const pendingProposal =
        await repositories.actionProposalRepository.transitionStatus(
          tenant,
          proposalId,
          'PROPOSED',
          'PENDING_APPROVAL',
          txOpts,
        );

      // 18. Append APPROVAL_REQUESTED audit event
      const requestedEvent = buildAuditEvent({
        eventType: 'APPROVAL_REQUESTED',
        organizationId: tenant.organizationId,
        actionProposalId: proposalId,
        approvalBindingHash,
        correlationId: params.correlationId,
        occurredAt: createdAt,
        payload: {
          actionProposalId: proposalId,
          requestedAt: createdAt,
          expiresAt,
          approvalBindingHash,
        },
      });
      await repositories.auditEventRepository.append(requestedEvent, txOpts);

      return pendingProposal;
    });
  } catch (error: unknown) {
    if (isCorrelationUniqueViolation(error)) {
      const replayedProposal =
        await repositories.actionProposalRepository.findByCorrelationId(
          tenant,
          params.correlationId,
        );
      if (replayedProposal) {
        return replayedProposal;
      }
    }
    throw error;
  }
}
