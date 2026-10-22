import {
  computeApprovalBindingHash,
  computeCanonicalParameterHash,
  type ActionProposal,
  type ApprovalRecord,
  type ExecutionResult,
  type TrustedActorContext,
} from '@clientops/contracts';
import type { TenantContext } from '@clientops/domain';
import { evaluatePolicy } from './policy.js';

export interface ExecutionPrecheckInput {
  readonly proposal: ActionProposal;
  readonly tenantContext: TenantContext;
  readonly approvalRecord: ApprovalRecord | null;
  readonly currentTimestamp: Date;
  readonly projectExistsAndActive?: boolean;
  readonly actualRecordVersions?:
    | ReadonlyMap<string, string>
    | Record<string, string>;
  readonly existingExecution?: ExecutionResult | null;
  readonly actorContext?: TrustedActorContext;
}

export interface ExecutionPrecheckResult {
  readonly allowed: boolean;
  readonly gateViolations: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Deterministically evaluates all execution gates before any WRITE action is permitted.
 *
 * TRANSACTION OWNERSHIP ARCHITECTURE:
 * Authoritative execution validation and mutation occur in ONE PostgreSQL transaction
 * owned by the component performing the task mutation.
 *
 * Transaction Sequence:
 * 1.  BEGIN
 * 2.  SELECT proposal FOR UPDATE
 * 3.  Load approval record
 * 4.  Verify status APPROVED
 * 5.  Verify tenant isolation (proposal.organizationId == tenant.organizationId)
 * 6.  Verify authorizer role on durable approvalRecord (admin or operator)
 * 7.  Verify validity periods (proposal and approval not expired)
 * 8.  Recompute approvalBindingHash and verify zero drift
 * 9.  Verify record-version preconditions (updated_at match against locked rows)
 * 10. Check existing execution records (idempotency enforcement)
 * 11. Reserve/create execution record
 * 12. Create task record (with materialized parameters)
 * 13. Read-back / verify task
 * 14. Transition proposal status to COMPLETED or FAILED
 * 15. Append audit events (EXECUTION_STARTED, EXECUTION_COMPLETED)
 * 16. COMMIT
 *
 * Prechecks outside the transaction (via validateExecutionPrecheck) are advisory only.
 */
export function validateExecutionPrecheck(
  input: ExecutionPrecheckInput,
): ExecutionPrecheckResult {
  const violations: string[] = [];
  const reasons: string[] = [];

  const {
    proposal,
    tenantContext,
    approvalRecord,
    currentTimestamp,
    projectExistsAndActive,
    existingExecution = null,
  } = input;

  // Gate 9 & 10: Policy check (EXTERNAL / DESTRUCTIVE actions prohibited)
  const policy = evaluatePolicy(proposal.actionType);
  if (
    proposal.actionClass === 'EXTERNAL' ||
    policy.actionClass === 'EXTERNAL'
  ) {
    violations.push('EXTERNAL_EXECUTION_PROHIBITED');
    reasons.push('EXTERNAL actions are strictly outside v1 scope and denied.');
  }

  if (
    proposal.actionClass === 'DESTRUCTIVE' ||
    policy.actionClass === 'DESTRUCTIVE'
  ) {
    violations.push('DESTRUCTIVE_EXECUTION_PROHIBITED');
    reasons.push(
      'DESTRUCTIVE actions are strictly outside v1 scope and denied.',
    );
  }

  // Gate 7: Cross-tenant isolation
  if (proposal.organizationId !== tenantContext.organizationId) {
    violations.push('CROSS_TENANT_VIOLATION');
    reasons.push(
      `Proposal organization (${proposal.organizationId}) does not match request tenant (${tenantContext.organizationId}).`,
    );
  }

  // Gate 1: Write without approval = 0
  if (!approvalRecord) {
    violations.push('MISSING_APPROVAL_RECORD');
    reasons.push(
      'WRITE actions require a durable approval record before execution.',
    );
  } else {
    // Gate 6: Denied approval execution = 0
    if (approvalRecord.decision !== 'APPROVE') {
      violations.push('DENIED_APPROVAL_EXECUTION');
      reasons.push(
        `Action proposal has decision '${approvalRecord.decision}' and cannot be executed.`,
      );
    }

    if (proposal.status === 'DENIED') {
      violations.push('DENIED_APPROVAL_EXECUTION');
      reasons.push('Action proposal status is DENIED.');
    }

    // Gate 7 (continued): Cross-tenant check on approval record
    if (approvalRecord.organizationId !== tenantContext.organizationId) {
      violations.push('CROSS_TENANT_VIOLATION');
      reasons.push(
        `Approval record organization (${approvalRecord.organizationId}) does not match request tenant (${tenantContext.organizationId}).`,
      );
    }

    // Link check: approval must bind exact proposal ID
    if (approvalRecord.actionProposalId !== proposal.id) {
      violations.push('APPROVAL_ID_MISMATCH');
      reasons.push(
        `Approval record references proposal '${approvalRecord.actionProposalId}', expected '${proposal.id}'.`,
      );
    }

    // Gate 12: Authoritative approval actor role must be admin or operator
    if (
      approvalRecord.actorRole !== 'admin' &&
      approvalRecord.actorRole !== 'operator'
    ) {
      violations.push('UNAUTHORIZED_ACTOR_ROLE');
      reasons.push(
        `Approval record actor role '${approvalRecord.actorRole}' is not authorized to approve actions (requires admin or operator).`,
      );
    }

    // Optional execution actor context checks if supplied (defense-in-depth)
    if (input.actorContext) {
      if (input.actorContext.organizationId !== tenantContext.organizationId) {
        violations.push('CROSS_TENANT_VIOLATION');
        reasons.push(
          `Actor organization (${input.actorContext.organizationId}) does not match request tenant (${tenantContext.organizationId}).`,
        );
      }
      if (
        input.actorContext.role !== 'admin' &&
        input.actorContext.role !== 'operator'
      ) {
        violations.push('UNAUTHORIZED_ACTOR_ROLE');
        reasons.push(
          `Actor role '${input.actorContext.role}' is not authorized to execute approved actions.`,
        );
      }
    }

    // Gate 4: Tampered parameters after approval = 0
    const recomputedHash = computeCanonicalParameterHash(proposal.parameters);
    if (recomputedHash !== proposal.parameterHash) {
      violations.push('PARAMETER_TAMPERING_DETECTED');
      reasons.push(
        `Proposal parameters hash mismatch: recomputed '${recomputedHash}' vs proposal '${proposal.parameterHash}'.`,
      );
    }

    if (proposal.parameterHash !== approvalRecord.parameterHash) {
      violations.push('PARAMETER_TAMPERING_DETECTED');
      reasons.push(
        `Proposal hash '${proposal.parameterHash}' does not match approval hash '${approvalRecord.parameterHash}'.`,
      );
    }

    // Gate 4b: Canonical Approval Binding / Authorization Fingerprint Verification
    // SHA-256(canonicalize({ organizationId, actionType, parameters, preconditions, expiresAt }))
    const recomputedBindingHash = computeApprovalBindingHash({
      organizationId: proposal.organizationId,
      actionType: proposal.actionType,
      parameters: proposal.parameters,
      preconditions: proposal.preconditions,
      expiresAt: proposal.expiresAt,
    });

    if (proposal.approvalBindingHash !== recomputedBindingHash) {
      violations.push('APPROVAL_BINDING_MISMATCH');
      reasons.push(
        `Proposal approvalBindingHash mismatch: recomputed '${recomputedBindingHash}' vs proposal '${proposal.approvalBindingHash}'.`,
      );
    }

    if (approvalRecord.approvalBindingHash !== recomputedBindingHash) {
      violations.push('APPROVAL_BINDING_MISMATCH');
      reasons.push(
        `Approval record binding hash mismatch: recomputed '${recomputedBindingHash}' vs approval record '${approvalRecord.approvalBindingHash}'.`,
      );
    }

    // Gate 5: Expired approval execution = 0
    const currentTimeMs = currentTimestamp.getTime();
    const proposalExpiresMs = new Date(proposal.expiresAt).getTime();
    const approvalValidUntilMs = new Date(approvalRecord.validUntil).getTime();

    if (currentTimeMs > proposalExpiresMs) {
      violations.push('EXPIRED_PROPOSAL_EXECUTION');
      reasons.push(
        `Action proposal expired at ${proposal.expiresAt} (current time: ${currentTimestamp.toISOString()}).`,
      );
    }

    if (currentTimeMs > approvalValidUntilMs) {
      violations.push('EXPIRED_APPROVAL_EXECUTION');
      reasons.push(
        `Approval validity period expired at ${approvalRecord.validUntil} (current time: ${currentTimestamp.toISOString()}).`,
      );
    }
  }

  // Gate 1 (continued): Status must be APPROVED
  if (proposal.status !== 'APPROVED') {
    violations.push('INVALID_PROPOSAL_STATUS');
    reasons.push(
      `Action proposal must be in 'APPROVED' status to execute (current status: '${proposal.status}').`,
    );
  }

  // Gate 8: Duplicate task creation = 0 (Idempotency)
  if (existingExecution) {
    violations.push('DUPLICATE_EXECUTION_ATTEMPT');
    reasons.push(
      `Proposal '${proposal.id}' has already been executed (executionId: '${existingExecution.executionId}', status: '${existingExecution.status}'). Duplicate mutation is prohibited.`,
    );
  }

  // Record Version / TOCTOU Protection: project must exist, be active, and verified
  if (projectExistsAndActive !== true) {
    violations.push('TOCTOU_PRECONDITION_FAILED');
    reasons.push(
      'Target project record precondition failed: project does not exist, is not active, or validity was not verified.',
    );
  }

  // Preconditions fail-closed check
  if (proposal.preconditions && proposal.preconditions.length > 0) {
    if (!input.actualRecordVersions) {
      violations.push('TOCTOU_PRECONDITION_FAILED');
      reasons.push(
        'Authoritative record versions were not supplied for required proposal preconditions.',
      );
    } else {
      for (const pre of proposal.preconditions) {
        if (pre.versionField !== 'updated_at') {
          violations.push('INVALID_PRECONDITION_FIELD');
          reasons.push(
            `Precondition versionField must be 'updated_at', got '${pre.versionField}'.`,
          );
        }
        const lookupKey = `${pre.entityType}:${pre.entityId}`;
        const actual =
          input.actualRecordVersions instanceof Map
            ? input.actualRecordVersions.get(lookupKey)
            : (input.actualRecordVersions as Record<string, string>)[lookupKey];
        if (!actual) {
          violations.push('TOCTOU_PRECONDITION_FAILED');
          reasons.push(
            `Precondition entity not found in backing store: ${pre.entityType} '${pre.entityId}'.`,
          );
        } else if (actual !== pre.expectedValue) {
          violations.push('TOCTOU_PRECONDITION_FAILED');
          reasons.push(
            `Record version mismatch for ${pre.entityType} '${pre.entityId}': expected updated_at '${pre.expectedValue}', actual '${actual}'.`,
          );
        }
      }
    }
  }

  return {
    allowed: violations.length === 0,
    gateViolations: violations,
    reasons,
  };
}
