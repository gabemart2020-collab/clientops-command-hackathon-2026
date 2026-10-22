import { randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  ActionExecutionRecord,
  ExecutionErrorCode,
} from '@clientops/contracts';
import {
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
  resolveSafeFailureSummary,
  sameOptionalInstant,
} from '@clientops/contracts';
import type {
  TenantContext,
  ActionProposalRepository,
  ActionApprovalRepository,
  ActionExecutionRepository,
  AuditEventRepository,
  ControlledTaskMutationRepository,
  UserRepository,
  ProjectRepository,
  MilestoneRepository,
  TaskEntity,
  Clock,
  RepositoryTransactionOptions,
} from '@clientops/domain';
import { SystemClock } from '@clientops/domain';
import type { TransactionRunner } from './proposal-service.js';
import {
  ProposalNotFoundError,
  UnauthorizedApproverError,
  ProposalTamperedError,
  ConflictError,
  InvalidProposalStatusError,
} from './approval-service.js';
import { SecurityBoundaryViolationError } from './actor-adapter.js';

export class PreconditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}

type QueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface ExecuteApprovedActionRepositories {
  readonly actionProposalRepository: ActionProposalRepository;
  readonly actionApprovalRepository: ActionApprovalRepository;
  readonly actionExecutionRepository: ActionExecutionRepository;
  readonly auditEventRepository: AuditEventRepository;
  readonly controlledTaskMutationRepository: ControlledTaskMutationRepository;
  readonly userRepository: UserRepository;
  readonly projectRepository: ProjectRepository;
  readonly milestoneRepository: MilestoneRepository;
}

export interface ExecuteApprovedActionParams {
  readonly tenant: TenantContext;
  readonly proposalId: string;
  readonly repositories: ExecuteApprovedActionRepositories;
  readonly transactionRunner: TransactionRunner;
  readonly clock?: Clock;
}

export interface ExecutionSuccessResult {
  readonly status: 'COMPLETED';
  readonly proposal: ActionProposal;
  readonly execution: ActionExecutionRecord;
  readonly task: TaskEntity;
  readonly idempotent: boolean;
}

export interface ExecutionFailureResult {
  readonly status: 'FAILED';
  readonly proposal: ActionProposal;
  readonly execution: ActionExecutionRecord;
  readonly errorCode: ExecutionErrorCode;
  readonly failureSummary: string;
  readonly idempotent: boolean;
}

export interface ExecutionExpiredResult {
  readonly status: 'EXPIRED';
  readonly proposal: ActionProposal;
  readonly reason:
    | 'PROPOSAL_EXPIRED'
    | 'APPROVAL_EXPIRED'
    | 'AUTHORIZATION_EXPIRED';
  readonly idempotent: boolean;
}

export type ExecuteApprovedActionResult =
  | ExecutionSuccessResult
  | ExecutionFailureResult
  | ExecutionExpiredResult;

/**
 * Authoritative, transactional execution of an approved task.create action proposal.
 *
 * Enforces the complete 17-step single-transaction authority flow:
 * 1.  SELECT proposal FOR UPDATE (by proposalId and organizationId)
 * 2.  Reconcile existing execution / proposal status (strict idempotency)
 * 3.  Require proposal status APPROVED
 * 4.  Load immutable ApprovalRecord (require decision == APPROVE, matching tenant)
 * 5.  Revalidate approving human against authoritative users table (must exist, role admin/operator, matching actorRole)
 * 6.  Verify validity periods (proposal and approval not expired; expire proposal + append audit if expired)
 * 7.  Recompute and verify parameterHash and approvalBindingHash zero-drift
 * 8.  Revalidate business relationships (assigneeUserId, projectId, milestoneId)
 * 9.  TOCTOU record-version precondition check with row locking
 * 10. Transition proposal APPROVED -> EXECUTING
 * 11. Create ActionExecution in EXECUTING status
 * 12. Append EXECUTION_STARTED audit event
 * 13. Establish SAVEPOINT task_mutation
 * 14. Deterministically INSERT task with frozen parameters
 * 15. Read back task and verify exact business fields
 * 16. On catchable mutation failure: ROLLBACK TO SAVEPOINT task_mutation, EXECUTING -> FAILED, append EXECUTION_FAILED
 * 17. On success: RELEASE SAVEPOINT, EXECUTING -> COMPLETED, proposal -> COMPLETED, append EXECUTION_COMPLETED, COMMIT
 */
export async function executeApprovedAction(
  params: ExecuteApprovedActionParams,
): Promise<ExecuteApprovedActionResult> {
  const { tenant, proposalId, repositories, transactionRunner, clock } = params;
  const activeClock = clock ?? new SystemClock();

  return transactionRunner(
    async (txOptions: RepositoryTransactionOptions = {}) => {
      // Step 1: Lock proposal FOR UPDATE
      const proposal = await repositories.actionProposalRepository.findById(
        tenant,
        proposalId,
        { ...txOptions, forUpdate: true },
      );

      if (!proposal) {
        throw new ProposalNotFoundError(
          `Action proposal '${proposalId}' not found in organization '${tenant.organizationId}'.`,
        );
      }

      if (proposal.organizationId !== tenant.organizationId) {
        throw new SecurityBoundaryViolationError(
          `Proposal organization '${proposal.organizationId}' does not match request tenant '${tenant.organizationId}'.`,
        );
      }

      // Step 2: Idempotency & Reconciliation: check existing execution, task, and approval records
      const existingExec =
        await repositories.actionExecutionRepository.findByProposalId(
          tenant,
          proposalId,
          txOptions,
        );
      const existingTask =
        await repositories.controlledTaskMutationRepository.findBySourceProposalId(
          tenant,
          proposalId,
          txOptions,
        );
      const approval =
        await repositories.actionApprovalRepository.findByProposalId(
          tenant,
          proposalId,
          txOptions,
        );

      if (existingExec) {
        if (existingExec.status === 'COMPLETED') {
          if (proposal.status !== 'COMPLETED') {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is COMPLETED but proposal status is '${proposal.status}' (expected 'COMPLETED').`,
            );
          }
          if (!approval) {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is COMPLETED but approval record is missing.`,
            );
          }
          if (approval.decision !== 'APPROVE') {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is COMPLETED but approval decision is '${approval.decision}' (expected 'APPROVE').`,
            );
          }
          if (existingExec.actionProposalId !== proposal.id) {
            throw new ConflictError(
              `Execution actionProposalId '${existingExec.actionProposalId}' does not match proposal id '${proposal.id}'.`,
            );
          }
          if (existingExec.actionApprovalId !== approval.id) {
            throw new ConflictError(
              `Execution actionApprovalId '${existingExec.actionApprovalId}' does not match approval id '${approval.id}'.`,
            );
          }
          if (existingExec.organizationId !== proposal.organizationId) {
            throw new ConflictError(
              `Execution organizationId '${existingExec.organizationId}' does not match proposal organizationId '${proposal.organizationId}'.`,
            );
          }
          if (
            existingExec.parameterHash !== proposal.parameterHash ||
            existingExec.parameterHash !== approval.parameterHash
          ) {
            throw new ConflictError(
              `Execution parameterHash does not match proposal or approval parameterHash.`,
            );
          }
          if (
            existingExec.approvalBindingHash !== proposal.approvalBindingHash ||
            existingExec.approvalBindingHash !== approval.approvalBindingHash
          ) {
            throw new ConflictError(
              `Execution approvalBindingHash does not match proposal or approval approvalBindingHash.`,
            );
          }
          if (existingExec.targetEntityType !== 'task') {
            throw new ConflictError(
              `Execution targetEntityType '${existingExec.targetEntityType}' is not 'task'.`,
            );
          }
          if (!existingTask) {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is COMPLETED but target task is missing from store.`,
            );
          }
          if (existingExec.targetEntityId !== existingTask.id) {
            throw new ConflictError(
              `Execution targetEntityId '${existingExec.targetEntityId}' does not match existing task id '${existingTask.id}'.`,
            );
          }
          if (existingTask.organizationId !== tenant.organizationId) {
            throw new ConflictError(
              `Existing task organizationId '${existingTask.organizationId}' does not match tenant '${tenant.organizationId}'.`,
            );
          }
          if (existingTask.sourceActionProposalId !== proposal.id) {
            throw new ConflictError(
              `Existing task sourceActionProposalId '${existingTask.sourceActionProposalId}' does not match proposal id '${proposal.id}'.`,
            );
          }
          return {
            status: 'COMPLETED',
            proposal,
            execution: existingExec,
            task: existingTask,
            idempotent: true,
          };
        }

        if (existingExec.status === 'FAILED') {
          if (proposal.status !== 'FAILED') {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is FAILED but proposal status is '${proposal.status}' (expected 'FAILED').`,
            );
          }
          if (!approval) {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is FAILED but approval record is missing.`,
            );
          }
          if (approval.decision !== 'APPROVE') {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is FAILED but approval decision is '${approval.decision}' (expected 'APPROVE').`,
            );
          }
          if (existingExec.actionApprovalId !== approval.id) {
            throw new ConflictError(
              `Execution actionApprovalId '${existingExec.actionApprovalId}' does not match approval id '${approval.id}'.`,
            );
          }
          if (
            existingExec.parameterHash !== proposal.parameterHash ||
            existingExec.parameterHash !== approval.parameterHash
          ) {
            throw new ConflictError(
              `Execution parameterHash does not match proposal or approval parameterHash.`,
            );
          }
          if (
            existingExec.approvalBindingHash !== proposal.approvalBindingHash ||
            existingExec.approvalBindingHash !== approval.approvalBindingHash
          ) {
            throw new ConflictError(
              `Execution approvalBindingHash does not match proposal or approval approvalBindingHash.`,
            );
          }
          if (existingTask) {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is FAILED but a target task exists in store.`,
            );
          }
          if (!existingExec.errorCode || !existingExec.failureSummary) {
            throw new ConflictError(
              `Execution for proposal '${proposalId}' is FAILED but errorCode or failureSummary is missing.`,
            );
          }
          return {
            status: 'FAILED',
            proposal,
            execution: existingExec,
            errorCode: existingExec.errorCode,
            failureSummary: existingExec.failureSummary,
            idempotent: true,
          };
        }

        if (existingExec.status === 'EXECUTING') {
          throw new ConflictError(
            `Proposal '${proposalId}' is currently being executed by another process.`,
          );
        }
      } else {
        // existingExec does not exist
        if (existingTask) {
          throw new ConflictError(
            `Target task exists for proposal '${proposalId}' but no action execution record was found.`,
          );
        }
      }

      if (proposal.status === 'EXPIRED') {
        const reason: 'PROPOSAL_EXPIRED' | 'APPROVAL_EXPIRED' =
          approval &&
          new Date(approval.validUntil).getTime() <=
            new Date(proposal.expiresAt).getTime()
            ? 'APPROVAL_EXPIRED'
            : 'PROPOSAL_EXPIRED';
        return {
          status: 'EXPIRED',
          proposal,
          reason,
          idempotent: true,
        };
      }

      // Step 3: Require proposal status APPROVED for new execution
      if (proposal.status !== 'APPROVED') {
        throw new InvalidProposalStatusError(
          `Cannot execute proposal '${proposalId}' in status '${proposal.status}' (expected 'APPROVED').`,
        );
      }

      // Step 4: Validate ApprovalRecord (already loaded)
      if (!approval) {
        throw new ConflictError(
          `No approval record found for proposal '${proposalId}'. Execution requires prior human approval.`,
        );
      }

      if (approval.decision !== 'APPROVE') {
        throw new ConflictError(
          `Approval decision for proposal '${proposalId}' is '${approval.decision}', cannot execute.`,
        );
      }

      if (approval.organizationId !== tenant.organizationId) {
        throw new SecurityBoundaryViolationError(
          `Approval record organization '${approval.organizationId}' does not match request tenant '${tenant.organizationId}'.`,
        );
      }

      // Step 5: Revalidate approving human from authoritative users table
      const approvingUser = await repositories.userRepository.findById(
        tenant,
        approval.actorId,
        { ...txOptions, forShare: true },
      );

      if (!approvingUser) {
        throw new UnauthorizedApproverError(
          `Approving actor '${approval.actorId}' does not exist in organization '${tenant.organizationId}'.`,
        );
      }

      if (approvingUser.role !== 'admin' && approvingUser.role !== 'operator') {
        throw new UnauthorizedApproverError(
          `Approving actor '${approval.actorId}' has non-approver role '${approvingUser.role}' (requires admin or operator).`,
        );
      }

      if (approvingUser.role !== approval.actorRole) {
        throw new UnauthorizedApproverError(
          `Approving actor role has changed from '${approval.actorRole}' to '${approvingUser.role}'.`,
        );
      }

      // Step 6: Verify validity periods
      const now = activeClock.now();
      const nowIso = now.toISOString();
      const proposalExpiresMs = new Date(proposal.expiresAt).getTime();
      const approvalValidUntilMs = new Date(approval.validUntil).getTime();
      const currentMs = now.getTime();

      if (currentMs > proposalExpiresMs || currentMs > approvalValidUntilMs) {
        const reason: 'PROPOSAL_EXPIRED' | 'APPROVAL_EXPIRED' =
          currentMs > proposalExpiresMs
            ? 'PROPOSAL_EXPIRED'
            : 'APPROVAL_EXPIRED';

        const expiredProposal =
          await repositories.actionProposalRepository.transitionStatus(
            tenant,
            proposalId,
            'APPROVED',
            'EXPIRED',
            txOptions,
          );

        await repositories.auditEventRepository.append(
          {
            id: randomUUID(),
            organizationId: tenant.organizationId,
            actionProposalId: proposal.id,
            eventType: 'ACTION_EXPIRED',
            actorId: approval.actorId,
            parameterHash: proposal.parameterHash,
            approvalBindingHash: proposal.approvalBindingHash,
            correlationId: proposal.correlationId,
            payload: {
              actionProposalId: proposal.id,
              expiredAt: nowIso,
              previousStatus: 'APPROVED',
            },
            occurredAt: nowIso,
          },
          txOptions,
        );

        return {
          status: 'EXPIRED',
          proposal: expiredProposal,
          reason,
          idempotent: false,
        };
      }

      // Step 7: Parameter hash & Approval binding hash verification
      const recomputedParamHash = computeCanonicalParameterHash(
        proposal.parameters,
      );
      if (
        recomputedParamHash !== proposal.parameterHash ||
        proposal.parameterHash !== approval.parameterHash
      ) {
        throw new ProposalTamperedError(
          `Parameter hash verification failed for proposal '${proposalId}'.`,
        );
      }

      const recomputedBindingHash = computeApprovalBindingHash({
        organizationId: proposal.organizationId,
        actionType: proposal.actionType,
        parameters: proposal.parameters,
        preconditions: proposal.preconditions,
        expiresAt: proposal.expiresAt,
      });

      if (
        recomputedBindingHash !== proposal.approvalBindingHash ||
        proposal.approvalBindingHash !== approval.approvalBindingHash
      ) {
        throw new ProposalTamperedError(
          `Approval binding hash verification failed for proposal '${proposalId}'.`,
        );
      }

      // Step 8: Revalidate tenant/business relationships
      // Assignee validation
      if (
        proposal.parameters.assigneeDisplayName &&
        !proposal.parameters.assigneeUserId
      ) {
        throw new PreconditionFailedError(
          `Assignee display name provided without authoritative assigneeUserId. Untrusted display-only assignees are prohibited.`,
        );
      }

      if (proposal.parameters.assigneeUserId) {
        const assigneeUser = await repositories.userRepository.findById(
          tenant,
          proposal.parameters.assigneeUserId,
          { ...txOptions, forShare: true },
        );
        if (!assigneeUser) {
          throw new PreconditionFailedError(
            `Assignee user '${proposal.parameters.assigneeUserId}' not found in organization '${tenant.organizationId}'.`,
          );
        }
        if (assigneeUser.organizationId !== tenant.organizationId) {
          throw new PreconditionFailedError(
            `Assignee user '${proposal.parameters.assigneeUserId}' belongs to organization '${assigneeUser.organizationId}', not '${tenant.organizationId}'.`,
          );
        }
        if (proposal.parameters.assigneeDisplayName) {
          const normalizeName = (s: string) =>
            s.trim().toLowerCase().replace(/\s+/g, ' ');
          if (
            normalizeName(proposal.parameters.assigneeDisplayName) !==
            normalizeName(assigneeUser.name)
          ) {
            throw new PreconditionFailedError(
              `Assignee display name '${proposal.parameters.assigneeDisplayName}' does not match authoritative user name '${assigneeUser.name}'.`,
            );
          }
        }
      }

      // Step 9: Target project validation & TOCTOU lock
      const targetProject = await repositories.projectRepository.findById(
        tenant,
        proposal.parameters.projectId,
        { ...txOptions, forShare: true },
      );

      if (!targetProject) {
        throw new PreconditionFailedError(
          `Target project '${proposal.parameters.projectId}' not found in organization '${tenant.organizationId}'.`,
        );
      }

      if (targetProject.clientId !== proposal.parameters.clientId) {
        throw new PreconditionFailedError(
          `Project '${targetProject.id}' belongs to client '${targetProject.clientId}', not proposal client '${proposal.parameters.clientId}'.`,
        );
      }

      if (
        ['archived', 'completed', 'cancelled'].includes(
          targetProject.status.toLowerCase(),
        )
      ) {
        throw new PreconditionFailedError(
          `Target project '${targetProject.id}' is in non-active status '${targetProject.status}'.`,
        );
      }

      // Milestone validation
      if (proposal.parameters.milestoneId) {
        const milestone = await repositories.milestoneRepository.findById(
          tenant,
          proposal.parameters.milestoneId,
          { ...txOptions, forShare: true },
        );
        if (!milestone) {
          throw new PreconditionFailedError(
            `Milestone '${proposal.parameters.milestoneId}' not found in organization '${tenant.organizationId}'.`,
          );
        }
        if (milestone.projectId !== targetProject.id) {
          throw new PreconditionFailedError(
            `Milestone '${milestone.id}' belongs to project '${milestone.projectId}', not target project '${targetProject.id}'.`,
          );
        }
      }

      // TOCTOU check against preconditions
      const projectPrecondition = proposal.preconditions.find(
        (p) =>
          p.entityType === 'project' &&
          p.entityId === targetProject.id &&
          p.versionField === 'updated_at',
      );

      if (!projectPrecondition) {
        throw new PreconditionFailedError(
          `Missing required project updated_at precondition for project '${targetProject.id}'.`,
        );
      }

      if (targetProject.updatedAt !== projectPrecondition.expectedValue) {
        throw new PreconditionFailedError(
          `TOCTOU check failed: project updated_at '${targetProject.updatedAt}' does not match expected version '${projectPrecondition.expectedValue}'.`,
        );
      }

      // Step 10: Transition proposal APPROVED -> EXECUTING
      await repositories.actionProposalRepository.transitionStatus(
        tenant,
        proposal.id,
        'APPROVED',
        'EXECUTING',
        txOptions,
      );

      // Step 11: Create ActionExecution in EXECUTING status
      const execution = await repositories.actionExecutionRepository.create(
        {
          organizationId: tenant.organizationId,
          actionProposalId: proposal.id,
          actionApprovalId: approval.id,
          executorPrincipal: 'clientops_trusted_executor',
          parameterHash: proposal.parameterHash,
          approvalBindingHash: proposal.approvalBindingHash,
          startedAt: nowIso,
        },
        txOptions,
      );

      // Step 12: Append EXECUTION_STARTED audit event
      await repositories.auditEventRepository.append(
        {
          id: randomUUID(),
          organizationId: tenant.organizationId,
          actionProposalId: proposal.id,
          eventType: 'EXECUTION_STARTED',
          actorId: approval.actorId,
          parameterHash: proposal.parameterHash,
          approvalBindingHash: proposal.approvalBindingHash,
          correlationId: proposal.correlationId,
          payload: {
            actionProposalId: proposal.id,
            executionId: execution.id,
            executorPrincipal: 'clientops_trusted_executor',
            startedAt: nowIso,
            approvalBindingHash: proposal.approvalBindingHash,
          },
          occurredAt: nowIso,
        },
        txOptions,
      );

      // Step 13: Establish SAVEPOINT task_mutation
      const hasClient = Boolean(txOptions?.client);
      if (hasClient) {
        const pgClient = txOptions!.client as QueryClient;
        await pgClient.query('SAVEPOINT task_mutation');
      }

      let createdTask: TaskEntity;
      try {
        // Step 14: Deterministically INSERT task
        createdTask =
          await repositories.controlledTaskMutationRepository.createControlledTask(
            tenant,
            {
              projectId: proposal.parameters.projectId,
              milestoneId: proposal.parameters.milestoneId,
              title: proposal.parameters.title,
              description: proposal.parameters.description,
              assigneeUserId: proposal.parameters.assigneeUserId,
              dueAt: proposal.parameters.dueAt,
              priority: proposal.parameters.priority ?? 'medium',
              sourceActionProposalId: proposal.id,
            },
            txOptions,
          );

        // Step 15: Read back task and verify exact business fields
        const readback =
          await repositories.controlledTaskMutationRepository.findById(
            tenant,
            createdTask.id,
            { ...txOptions, forShare: true },
          );

        if (!readback) {
          throw new Error('Created task could not be read back from store.');
        }

        const norm = (v?: string | null) =>
          v === undefined || v === null ? undefined : v;

        const isExactMatch =
          readback.organizationId === tenant.organizationId &&
          readback.projectId === proposal.parameters.projectId &&
          norm(readback.milestoneId) ===
            norm(proposal.parameters.milestoneId) &&
          readback.title === proposal.parameters.title &&
          norm(readback.description) ===
            norm(proposal.parameters.description) &&
          norm(readback.assigneeUserId) ===
            norm(proposal.parameters.assigneeUserId) &&
          sameOptionalInstant(readback.dueAt, proposal.parameters.dueAt) &&
          readback.priority === (proposal.parameters.priority ?? 'medium') &&
          readback.status === 'open' &&
          readback.sourceActionProposalId === proposal.id;

        if (!isExactMatch) {
          throw new Error(
            'Task readback verification failed: fields do not match approved parameters.',
          );
        }

        if (hasClient) {
          const pgClient = txOptions!.client as QueryClient;
          await pgClient.query('RELEASE SAVEPOINT task_mutation');
        }
      } catch {
        // Step 16: Recoverable mutation failure
        if (hasClient) {
          const pgClient = txOptions!.client as QueryClient;
          await pgClient.query('ROLLBACK TO SAVEPOINT task_mutation');
        }

        const safe = resolveSafeFailureSummary('TASK_CREATION_FAILED');
        const failureTime = activeClock.now().toISOString();

        const failedExecution =
          await repositories.actionExecutionRepository.updateResult(
            tenant,
            proposal.id,
            {
              status: 'FAILED',
              errorCode: safe.errorCode,
              failureSummary: safe.failureSummary,
              completedAt: failureTime,
            },
            txOptions,
          );

        const failedProposal =
          await repositories.actionProposalRepository.transitionStatus(
            tenant,
            proposal.id,
            'EXECUTING',
            'FAILED',
            txOptions,
          );

        await repositories.auditEventRepository.append(
          {
            id: randomUUID(),
            organizationId: tenant.organizationId,
            actionProposalId: proposal.id,
            eventType: 'EXECUTION_FAILED',
            actorId: approval.actorId,
            parameterHash: proposal.parameterHash,
            approvalBindingHash: proposal.approvalBindingHash,
            correlationId: proposal.correlationId,
            payload: {
              actionProposalId: proposal.id,
              executionId: execution.id,
              errorCode: safe.errorCode,
              failureSummary: safe.failureSummary,
              failedAt: failureTime,
            },
            occurredAt: failureTime,
          },
          txOptions,
        );

        return {
          status: 'FAILED',
          proposal: failedProposal,
          execution: failedExecution,
          errorCode: safe.errorCode,
          failureSummary: safe.failureSummary,
          idempotent: false,
        };
      }

      // Step 17: Mutation succeeded! Finalize execution:
      const completionTime = activeClock.now().toISOString();

      const completedExecution =
        await repositories.actionExecutionRepository.updateResult(
          tenant,
          proposal.id,
          {
            status: 'COMPLETED',
            targetEntityId: createdTask.id,
            completedAt: completionTime,
          },
          txOptions,
        );

      const completedProposal =
        await repositories.actionProposalRepository.transitionStatus(
          tenant,
          proposal.id,
          'EXECUTING',
          'COMPLETED',
          txOptions,
        );

      await repositories.auditEventRepository.append(
        {
          id: randomUUID(),
          organizationId: tenant.organizationId,
          actionProposalId: proposal.id,
          eventType: 'EXECUTION_COMPLETED',
          actorId: approval.actorId,
          parameterHash: proposal.parameterHash,
          approvalBindingHash: proposal.approvalBindingHash,
          correlationId: proposal.correlationId,
          payload: {
            actionProposalId: proposal.id,
            executionId: execution.id,
            targetEntityType: 'task',
            targetEntityId: createdTask.id,
            completedAt: completionTime,
          },
          occurredAt: completionTime,
        },
        txOptions,
      );

      return {
        status: 'COMPLETED',
        proposal: completedProposal,
        execution: completedExecution,
        task: createdTask,
        idempotent: false,
      };
    },
  );
}
