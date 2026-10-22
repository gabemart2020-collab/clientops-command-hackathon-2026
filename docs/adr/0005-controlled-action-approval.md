# 0005: Controlled action approval, trusted executor, and append-only audit

Status: Accepted architectural decision for Phase 4 (Hardened Phase 4.0.1; Schema Freeze Phase 4.1.2/4.1.3; Proposal Registration & Human Approval Implemented & Live Certified Phase 4.2; Controlled Task Execution Implemented & Live Certified Phase 4.3).
Date: 2026-10-05.  
Authority: Explicit user authorization of Phase 4, Phase 4.0.1, Phase 4.2, and Phase 4.3.

## Context

Phase 3 established an agentic orchestration layer capable of understanding operational requests, querying domain context, analyzing delivery risks with deterministic rules, and synthesizing grounded, evidence-backed briefings.

Phase 4 moves ClientOps Command from a READ / ANALYZE agent to a controlled operational action lifecycle:

```text
UNDERSTAND → ASSESS → PLAN → RECOMMEND → PROPOSE ACTION → HUMAN APPROVAL → EXECUTE → VERIFY → AUDIT → REMEMBER
```

When an agent is empowered to affect domain state, critical risks emerge:

1. **Model Self-Authorization:** An LLM might attempt to approve its own proposals or bypass human oversight via hallucinated permissions or prompt injections.
2. **Parameter Tampering / Drift:** Parameters reviewed and approved by a human might be subtly altered between approval and execution.
3. **Time-of-Check to Time-of-Use (TOCTOU) Invalidation:** Underlying domain state (such as project status or milestone dates) might change between approval and execution, making the action unsafe or obsolete.
4. **Duplicate Execution / Non-Idempotency:** Retries, network drops, or duplicate button clicks might trigger multiple task creations.
5. **Audit Modification & Contamination:** Audit logs could be modified, deleted, or contaminated with unbounded prompts, chain-of-thought, or credentials.
6. **Scope Creep:** Unauthorized external communications (email/Slack), unknown operations, or destructive database operations might be triggered.

## Decision

We establish the following architectural invariants for Phase 4 (hardened in Phase 4.0.1):

### 1. Human Approval Trust Boundary Outside MCP (Reaffirming ADR 0003)

Human approval resolution is strictly an application-level boundary. It is never exposed as an MCP tool. Neither `action.approve` nor `action.deny` will ever exist in the MCP tool catalog. Approval requires a server-resolved `TrustedActorContext` (role: `admin` or `operator`; `viewer` is denied). Production authentication / identity-provider integration is planned but not yet implemented; the local demo actor is dev/test-only and fail-closed elsewhere.

### 2. Proposer vs. Executor Separation & Tool Discovery

The normal Strands operations agent is an untrusted proposer:

- Discovers ONLY authorized READ and ANALYZE tools (`account.get_context`, `activity.get_recent`, `commitment.list_open`, `project.assess_delivery_health`, `meeting.prepare_brief`).
- Does NOT discover WRITE tools.
- Can emit an `ModelActionProposalInput` suggestion (with target parameters, bounded `justification`, and citation pointers).
- Cannot approve or execute actions.

Approved actions are executed exclusively by a dedicated, trusted server executor component outside the model's conversation loop.

### 3. Execution by Approved Proposal ID Only

The trusted server executor is invoked with the approved proposal's identifier (`executeApprovedAction({ proposalId, ... })`) plus server-owned tenant/dependency context. It does NOT accept model-authored or browser-supplied action parameters at execution time. The executor directly reloads the immutable proposal from the durable PostgreSQL store within verified tenant context. This eliminates any possibility of parameter tampering or drift after approval.

### 4. Canonical Parameter Hashing & Approval Binding Fingerprint

- Every proposal materializes parameter defaults (e.g. `priority: 'medium'`) before computing a deterministic SHA-256 canonical parameter hash (`computeCanonicalParameterHash`) with sorted JSON keys.
- In addition, a canonical **approval authorization fingerprint** (`approvalBindingHash`) is computed:
  ```text
  approvalBindingHash = SHA-256(canonicalize({
    organizationId,
    actionType,
    parameters,
    preconditions,
    expiresAt
  }))
  ```
- `ApprovalRecord` stores this exact binding hash.
- Before execution, the executor recomputes both hashes from the database row and verifies strict equality. Any drift in organization, action type, parameters, preconditions, or validity expiration fails closed with `APPROVAL_BINDING_MISMATCH`.

### 5. 8-State Deterministic Action Lifecycle State Machine

Proposals follow an immutable state machine:

- `PROPOSED` → `PENDING_APPROVAL` | `EXPIRED`
- `PENDING_APPROVAL` → `APPROVED` | `DENIED` | `EXPIRED`
- `APPROVED` → `EXECUTING` | `EXPIRED`
- `EXECUTING` → `COMPLETED` | `FAILED`

Terminal states: `DENIED`, `EXPIRED`, `COMPLETED`, `FAILED` have zero allowed transitions.
Note: `PROPOSED → DENIED` is explicitly forbidden. Human denial requires a proposal to be in `PENDING_APPROVAL` state. Policy denials occur prior to proposal registration and are not represented as human approval denials. Illegal transitions fail closed and throw `IllegalStateTransitionError`.

### 6. Unknown Actions Deterministically Evaluated to DENIED

Unknown action types MUST deterministically evaluate to `decision: 'DENIED'` and `actionClass: 'EXTERNAL'`. Unrecognized actions are never classified as `WRITE` and are never permitted to request human approval.

### 7. Proposal Evidence Architecture (Citation Pointers Only)

Reusing the Phase 3 evidence architecture:

- Untrusted `ModelActionProposalInput` emits citation pointers only (`entityType`, `entityId`, optional `field`). It is forbidden from supplying authoritative evidence excerpts.
- Proposal registration resolves citations against the request-local authoritative evidence registry.
- Only canonical server-hydrated `EvidenceRef` records are persisted in the proposal.
- Fabricated, unknown, wrong-field, or ambiguous citations reject proposal registration immediately.

### 8. Record Version Semantics (Authoritative `updated_at` Column)

Record version preconditions (`RecordVersionPrecondition`) bind strictly to existing entity schema timestamps:

- `versionField: 'updated_at'`
- `expectedValue: string` (ISO 8601 datetime)
- For `task.create`, the proposal binds at minimum to the target `project` record. Unsupported revision counters are not invented.

### 9. Single PostgreSQL Transaction Ownership for Execution

Authoritative execution validation and mutation occur in **ONE PostgreSQL transaction** owned by the component performing the task mutation:

1. `BEGIN`
2. `SELECT proposal FOR UPDATE`
3. Load approval record
4. Verify status `APPROVED`
5. Verify tenant isolation (`proposal.organizationId == actor.organizationId == tenant.organizationId`)
6. Verify actor role (`admin` or `operator`)
7. Verify validity periods (`currentTimestamp <= expiresAt` and `<= validUntil`)
8. Recompute `approvalBindingHash` and verify equality
9. Verify record-version preconditions (`updated_at` matches locked backing rows)
10. Verify no existing execution record exists (idempotency check)
11. Reserve/insert execution record
12. Create business task record with materialized parameters
13. Read-back and verify task creation
14. Transition proposal status to `COMPLETED` (or `FAILED` on execution error)
15. Append allowlisted audit events
16. `COMMIT`

Prechecks outside the transaction (`validateExecutionPrecheck`) are advisory only.

### 10. Trusted Actor Abstraction & Non-Production Guard

Production authentication is **planned**, not yet implemented. In Phase 4, the `TrustedActorContext` abstraction defines actor identity, tenant, and role.
For development and test environments, `createLocalDemoActorContext` is provided. It fails closed unless:

- `NODE_ENV` is strictly `'development'` or `'test'`.
- In development, the explicit opt-in flag `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true` is set.
  All other environments (production, staging, preview, undefined) fail closed with a security boundary error.

### 11. Strict Event-Specific Allowlisted Audit Schemas

Audit events must never accept generic arbitrary model or provider payloads.

- Strict `z.strictObject` schemas define allowed fields for each of the 8 lifecycle events (`ActionProposedPayload`, `ApprovalRequestedPayload`, `ActionApprovedPayload`, etc.).
- Payloads reject any unexpected properties.
- Audit events never store raw prompts, chain-of-thought, raw exception objects, stack traces, credentials, or unbounded model text.
- Immutability is enforced at the PostgreSQL engine level via a trigger function rejecting any `UPDATE` or `DELETE` on `audit_events`.
- Defense-in-depth sanitization strips `FORBIDDEN_AUDIT_KEYS`.

### 12. Contract Cleanup

- Replaced model reasoning with bounded, user-facing `justification` (max 1000 characters).
- Resolved assignee ambiguity: `assigneeUserId` (UUID) is canonical for mutation; `assigneeDisplayName` is display-only.
- Defaults (`priority: 'medium'`) are materialized before canonical hashing.

### 13. Durable Persistence, Composite Constraints, and Execution Invariant Freeze (Phase 4.1, 4.1.1 & 4.1.2 Freeze)

- **Database Triggers for Engine-Level Defense:**
  - `trg_action_proposals_freeze`: Enforces immutability of authorization-critical fields and legal state machine transitions.
  - `trg_action_proposals_no_delete`: Rejects any `DELETE` on action proposals.
  - `trg_action_approvals_immutable`: Rejects any `UPDATE` or `DELETE` on approvals.
  - `trg_action_approvals_validate`: Validates before insert that:
    1. Proposal exists in tenant and status is strictly `PENDING_APPROVAL`.
    2. Proposal has not expired at decision time (`decided_at <= proposal.expires_at`).
    3. Approval validity interval is sound (`valid_until > decided_at` and `valid_until <= proposal.expires_at`).
    4. Hashes match using NULL-safe equality (`parameter_hash` and `approval_binding_hash`).
    5. Authoritative user in `users(id, organization_id)` has role `admin` or `operator`, and `actor_role` snapshot matches authoritative user role exactly (rejecting viewer role elevation).
  - `trg_action_executions_freeze`: Freezes all authorization and creation fields (`id`, `organization_id`, `action_proposal_id`, `action_approval_id`, `executor_principal`, `parameter_hash`, `approval_binding_hash`, `started_at`, `target_entity_type`); only lifecycle fields may mutate (`status`, `target_entity_id`, `completed_at`, `error_code`, `failure_summary`); enforces execution state machine (`EXECUTING -> COMPLETED | FAILED`, terminal, rejects self-transitions).
  - `trg_action_executions_no_delete`: Rejects any `DELETE` on action executions.
  - `trg_audit_events_immutable`: Rejects any `UPDATE` or `DELETE` on audit events.
- **Composite Foreign Key Multi-Tenant Isolation & Actor Boundaries:**
  - `users`: `UNIQUE (id, organization_id)` enforces tenant-bound user identity.
  - `action_approvals`: Composite FK `(actor_id, organization_id) REFERENCES users(id, organization_id)` prevents cross-tenant approvers. Composite unique constraint `UNIQUE (id, action_proposal_id, organization_id)`.
  - `action_executions`: Composite FK `(action_approval_id, action_proposal_id, organization_id) REFERENCES action_approvals(id, action_proposal_id, organization_id)` with `action_approval_id NOT NULL` guarantees execution binds strictly to the exact approved decision within the same proposal and tenant.
  - `audit_events`: Composite FK `(action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)` and composite FK `(actor_id, organization_id) REFERENCES users(id, organization_id)` physically prevent cross-tenant audit proposal and actor references.
- **Human Actor vs. Server Executor Separation:**
  - Approval row records human approver (`actor_id` references `users(id, organization_id)`).
  - Execution row records server-owned executor identity (`executor_principal = 'clientops_trusted_executor'`), never accepted from model, MCP, or HTTP client headers.
- **Grounded Action Proposals & Target Project Binding:**
  - For `task.create`, proposals enforce `jsonb_array_length(evidence) >= 1` and `jsonb_array_length(preconditions) >= 1` in DB CHECK constraints.
  - `ActionProposalSchema` strictly enforces that at least one precondition binds directly to the actual target project (`entityType: 'project'`, `entityId: parameters.projectId`, `versionField: 'updated_at'`). Mismatched project preconditions are rejected fail-closed.
  - Hashes enforce strict SHA-256 lowercase hex format `^[0-9a-f]{64}$` in DB CHECK constraints and Zod schemas.
- **Safe Failure Persistence Contract (Zero Raw Errors):**
  - Raw caught `Error.message`, provider responses, or SQL exception strings are NOT the normal durable failure summary source.
  - Future executor maps known execution failures to bounded stable error codes (`ExecutionErrorCode`) and safe predefined summaries (`SAFE_FAILURE_SUMMARIES`).
  - Unknown or unmapped failures safely default to `INTERNAL_EXECUTION_ERROR` ("Task creation failed due to an internal execution error.").
  - Defense-in-depth `sanitizeFailureSummary` bounds messages to 500 characters and redacts tokens, credentials, and paths.
- **Transaction Client Injection:**
  Repository interfaces support optional `options?: RepositoryTransactionOptions` accepting an active client (`PoolClient`), enabling atomic caller-owned execution transactions.
- **Infrastructure Failure & Transaction Abort Semantics:**
  - If a database connection or infrastructure crash occurs during execution, the single PostgreSQL transaction rolls back entirely. Because the transaction rolls back, the database state of the proposal remains in its prior committed state: `APPROVED`.
  - The system does NOT manufacture an illegal `APPROVED -> FAILED` transition (the frozen state machine strictly forbids it: `APPROVED` may only transition to `EXECUTING` or `EXPIRED`).
  - Upon reconnection, reconciliation occurs safely by querying by proposal ID to determine whether an `action_executions` row was committed or if execution should be safely retried.
  - For catchable domain mutation errors (e.g. business validation failures), the executor establishes a savepoint `SAVEPOINT task_mutation;`. If the mutation fails, it rolls back to the savepoint (`ROLLBACK TO SAVEPOINT task_mutation;`), marks the execution `FAILED` with safe failure summary, transitions the proposal to `FAILED` (from `EXECUTING`), records the `EXECUTION_FAILED` audit event, and commits the transaction.

### 14. Controlled Task Execution Implementation (Phase 4.3 Implemented & Live Certified)

- **Zero WRITE MCP Tools:** Strands agent remains strictly READ/ANALYZE only. Zero WRITE tools exist in MCP catalog.
- **Trusted Server Execution Service:** `executeApprovedAction(params: ExecuteApprovedActionParams)` implemented in `packages/policy/src/execution-service.ts`.
- **Invoked Exclusively by `proposalId`:** Parameter tampering is physically prevented because no caller parameters are accepted; the caller supplies the approved proposal's ID (`proposalId`), tenant context, repositories, and transaction runner.
- **Dual Durable Idempotency Barriers:** Enforced by engine unique constraints `UNIQUE(action_executions.action_proposal_id)` and `UNIQUE(tasks.source_action_proposal_id)`.
- **Application Integration:** Automatic transactional execution upon human `APPROVE` resolution in `/api/actions/[proposalId]/decision`. On `DENY`, executor is never called.
- **Live Certified:** Certified end-to-end against live Amazon Bedrock in Phase 4.3 (1 real task created, zero duplicates on retry, zero WRITE MCP tools exposed).

## Consequences

- **Positive:** Guarantees zero unapproved writes, zero model self-authorizations, zero parameter tampering, zero TOCTOU drift, and exactly-once execution. Complete, immutable, schema-validated audit trail.
- **Negative:** Requires human interaction for every WRITE action. Execution involves durable database queries and row locks.
- **Validation:** 12 frozen security gates are verified offline with zero violations (`packages/policy/src/policy.test.ts`).

## Alternatives considered

- **Exposing approval as an MCP tool:** Rejected. Allowing an agent to call an approval tool enables prompt injection and self-authorization attacks.
- **Passing parameters to executor:** Rejected. Re-passing parameters at execution time introduces a tampering window between human review and execution.
- **Process-local idempotency maps:** Rejected. Violates ADR 0002; fails across server restarts, multi-container deployments, or worker crashes.

Changes to this decision require a superseding ADR and explicit user agreement before implementation.
