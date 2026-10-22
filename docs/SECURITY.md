# Security boundaries

**Verified requirement — user brief:** never commit secrets, expose privileged browser credentials, perform destructive database operations, or allow the LLM to approve its own actions. Audit records must be append-only. EXTERNAL and DESTRUCTIVE actions are outside v1.

**Architectural decision:** human approval is a separate trust boundary, enforced deterministically on the server. The agent cannot resolve approvals through MCP or through service credentials. Model output, tool arguments, and retrieved documents are untrusted.

## Implemented controls (Phases 1, 2, 3 & Phase 4.0.1)

- **Database Target Safety:** local mode preserves `assertLocalDatabaseTarget()` for loopback/container development databases. Phase 5.1 staging mode is explicitly limited to the MCP workload and requires the exact configured non-production host/database/user, TLS, and read-only privilege preflight; production/customer targets and generic remote bypasses remain prohibited.
- **Tenant Context Requirement:** All repositories and policy gates require `TenantContext` (`{ organizationId: string }`). Organization ID cannot be manipulated through model/browser MCP tool arguments.
- **Cross-Tenant Isolation:** Verified via unit and integration tests across data, agent, policy, and hero suites.
- **Stateless MCP Transport Security:** Loopback default binding (`127.0.0.1`), 64KB maximum request body size limit, strict `Host` header validation, and exact `Origin` validation.
- **Separation of Proposer vs. Executor:** The Strands operations agent discovers only authorized READ and ANALYZE tools; it does NOT discover WRITE tools. The trusted server executor alone executes approved WRITE actions.
- **The 12 Frozen Security Gates (Phase 4.0.1):**
  1. `write without approval = 0`: WRITE actions strictly fail closed unless a durable approval record exists in `APPROVED` status.
  2. `model approval capability = 0`: LLM output is an untrusted suggestion; the model cannot approve actions, set approval state, or transition the state machine.
  3. `approval MCP tools = 0`: Zero approval tools exist in the MCP tool surface; approval resolution lives exclusively in an authenticated application route.
  4. `tampered parameters after approval = 0`: Recomputed canonical parameter hash (`computeCanonicalParameterHash`) must match the approved proposal and approval record; tampering fails closed.
     4b. `approval authorization fingerprint verification = 0`: Recomputed `approvalBindingHash = SHA-256(canonicalize({ organizationId, actionType, parameters, preconditions, expiresAt }))` must match both the proposal and approval record; drift in parameters, preconditions, tenant, or expiration fails closed.
     4c. `record-version TOCTOU protection = 0`: Preconditions bind strictly to `versionField: 'updated_at'` and are validated against locked backing PostgreSQL rows inside the execution transaction; stale versions fail closed.
  5. `expired approval execution = 0`: Proposals past `expiresAt` or approvals past `validUntil` cannot execute.
  6. `denied approval execution = 0`: `DENIED` proposals or `DENY` decisions are terminal and cannot transition to executing. Human DENIED requires `PENDING_APPROVAL` state (`PROPOSED -> DENIED` is forbidden).
  7. `cross-tenant execution = 0`: Proposal organization, approval record organization, and actor organization must strictly match the verified `TenantContext`.
  8. `duplicate task creation = 0`: Exactly-once execution enforced via database unique constraint `UNIQUE(proposal_id)` and transaction row locks; process memory is not relied upon.
  9. `EXTERNAL execution = 0`: EXTERNAL tools (email, Slack, webhooks) and unknown actions are classified as EXTERNAL and denied by policy in v1.
  10. `DESTRUCTIVE execution = 0`: DESTRUCTIVE operations (table drops, deletes, resets) are classified as DESTRUCTIVE and denied by policy in v1.
  11. `audit UPDATE/DELETE = 0`: Audit persistence is strictly append-only; immutability enforced at the database engine level via PostgreSQL trigger rejecting UPDATE/DELETE.
  12. `untrusted actor approval = 0`: Approver must possess an authorized role (`admin` or `operator`; `viewer` is rejected); `LocalDemoActorAdapter` strictly fails closed unless running in `development` or `test` with `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true` in development. Staging, preview, undefined, and production fail closed.
- **Single PostgreSQL Transaction Execution:** Authoritative validation and mutation execute within ONE transaction owned by the mutating component (`SELECT ... FOR UPDATE`, verify approval, verify binding hash, verify preconditions, idempotency check, task creation, read-back, audit append, `COMMIT`). Prechecks outside the transaction are advisory only.
- **Proposal Evidence Architecture:** Model emits citation pointers only (`entityType`, `entityId`, optional `field`). Authoritative excerpts are hydrated server-side from request-local evidence registry. Mismatched or fabricated citations fail closed and reject registration.
- **Strict Allowlisted Audit Schemas:** Payloads are validated against strict `z.strictObject` schemas, rejecting arbitrary model text, prompts, CoT, exception objects, or stack traces. Secret redaction (`FORBIDDEN_AUDIT_KEYS`) operates as defense-in-depth.
- **Defense-in-Depth Tool Interception:** The Strands `BeforeToolCallEvent` hook intercepts all tool calls and enforces `isToolAuthorized()`, failing closed if any unauthorized tool is attempted.
- **Zero-Hallucination Grounding Validator:** Emitted `EvidenceRef` items must match authoritative database records observed during the invocation. Briefs with unsupported references fail validation.
- **Prompt Injection Defense:** `CLIENTOPS_SYSTEM_PROMPT` enforces that retrieved business data (emails, notes, meeting transcripts) is treated as untrusted content, never executed as instructions.
- **Credential Hygiene:** Standard AWS credential chain used exclusively on the server side (`packages/agent`). No AWS credentials or secrets in `NEXT_PUBLIC_*` variables, browser bundles, logs, or Git commits.
- **Input Validation:** Strict Zod schemas on all tool inputs, outputs, proposals, parameters, and audit payloads.

- **Phase 4.1, Phase 4.1.1, Phase 4.1.2 & Phase 4.1.3 Database Engine Security Controls:**
  - **Initial Proposal & Execution State Enforcement:**
    - `trg_action_proposals_initial_status`: Enforces `status = 'PROPOSED'` on INSERT, rejecting any attempt to persist `PENDING_APPROVAL`, `APPROVED`, `DENIED`, `EXPIRED`, `EXECUTING`, `COMPLETED`, or `FAILED` directly.
    - `trg_action_executions_initial_state`: Enforces `status = 'EXECUTING'` on INSERT and requires `completed_at`, `target_entity_id`, `error_code`, and `failure_summary` to be strictly NULL on execution reservation.
  - **Authoritative Audit Event Validation Trigger:**
    - `trg_audit_events_validate`: Enforces at database level that `ACTION_APPROVED` and `ACTION_DENIED` audit events require `actorRole` to be `admin` or `operator`, rejecting `viewer` or unauthorized roles.
  - **Audit Event Discriminated Union:** Contracts enforce `z.discriminatedUnion('eventType', [...])` binding each event type strictly to its dedicated schema and prohibiting mismatched payloads.
  - **Composite Foreign Key Boundaries & Exact Approval Binding:**
    - `users`: `UNIQUE (id, organization_id)` enforces tenant-scoped users.
    - `action_approvals`: `(actor_id, organization_id) REFERENCES users(id, organization_id)` prevents cross-tenant approvers. `(action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)`.
    - `action_executions`: Composite FK `(action_approval_id, action_proposal_id, organization_id) REFERENCES action_approvals(id, action_proposal_id, organization_id)` with `action_approval_id NOT NULL` strictly binds execution to the exact approval decision within the same proposal and tenant. Cross-tenant or mismatched proposal execution is physically rejected.
    - `audit_events`: Composite FK `(action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)` and composite FK `(actor_id, organization_id) REFERENCES users(id, organization_id)` physically prevent cross-tenant audit proposal and actor references.
  - **Human Actor vs. Server Executor Separation:** Approval rows record the human actor (`actor_id`); execution rows record a server-owned identity (`executor_principal = 'clientops_trusted_executor'`). The executor identity cannot be supplied by HTTP clients, models, or MCP callers.
  - **Proposal Immutability & Target Project Precondition Grounding:**
    - `trg_action_proposals_freeze`: Prohibits mutation of all authorization-critical fields and enforces state machine transitions upon `status` updates.
    - `trg_action_proposals_no_delete`: Directly aborts any SQL `DELETE` on `action_proposals`.
    - DB CHECK constraints enforce `jsonb_array_length(evidence) >= 1` and `jsonb_array_length(preconditions) >= 1` for `task.create`.
    - `ActionProposalSchema` enforces that at least one precondition binds directly to the actual target project (`entityType: 'project'`, `entityId == parameters.projectId`, `versionField == 'updated_at'`).
  - **Approval Validation, Time Validity & Immutability Triggers:**
    - `trg_action_approvals_validate`: Enforces before insert that: proposal exists in tenant and status is `PENDING_APPROVAL`, proposal is not expired (`decided_at <= expires_at`), validity interval is sound (`valid_until > decided_at` and `valid_until <= expires_at`), parameter and binding hashes match using NULL-safe `IS DISTINCT FROM`, authoritative user exists in `users(id, organization_id)` with role `admin` or `operator`, and snapshot `actor_role` matches authoritative user role exactly (preventing viewer role escalation).
    - `trg_action_approvals_immutable`: Directly aborts any SQL `UPDATE` or `DELETE` on `action_approvals`.
  - **Execution Authorization Freeze & State Machine Enforcement:**
    - `trg_action_executions_freeze`: Freezes all authorization fields (`id`, `organization_id`, `action_proposal_id`, `action_approval_id`, `executor_principal`, `parameter_hash`, `approval_binding_hash`, `started_at`, `target_entity_type`) and enforces execution state machine transitions (`EXECUTING -> COMPLETED | FAILED`, terminal, rejects self-transitions).
    - `uq_action_executions_proposal`: Enforces exactly-once execution boundary.
    - `trg_action_executions_no_delete`: Directly aborts any SQL `DELETE` on `action_executions`.
  - **Audit Immutability Trigger (`trg_audit_events_immutable`):** Directly aborts any SQL `UPDATE` or `DELETE` on `audit_events`.
  - **Safe Failure Persistence Contract (Zero Raw Errors):** Raw error strings and exception objects are replaced with stable error codes (`ExecutionErrorCode`) and safe predefined summaries (`SAFE_FAILURE_SUMMARIES`). Unknown errors safely default to `INTERNAL_EXECUTION_ERROR`. Defense-in-depth sanitization bounds summaries to 500 characters and redacts credentials and paths.
  - **Hash Format Hardening:** DB CHECK constraints and Zod schemas enforce lowercase 64-character SHA-256 regex `^[0-9a-f]{64}$` for `parameter_hash` and `approval_binding_hash`.
  - **Strict Repository Boundaries:** `ActionApprovalRepository` and `AuditEventRepository` do not define or expose `update` or `delete` methods. All references enforce `ON DELETE RESTRICT`.

## Phase 4.2 / 4.2.1 Implemented Security Controls

- **Untrusted Browser / Model Input Trust Boundary:**
  - Browser/client HTTP requests cannot supply trusted identity or policy fields (`actorId`, `organizationId`, `parameterHash`, `approvalBindingHash`, `status`, `expiresAt`, `createdAt`).
  - Approval decision endpoint strictly enforces `ApprovalDecisionRequestSchema = { decision: 'APPROVE' | 'DENY', comment?: string (max 500) }`. Any unrecognized or forbidden properties immediately fail closed with validation errors.
  - Mandatory `TransactionRunner` in proposal registration and approval decision services guarantees all state transitions and audit logs occur within a single database transaction.
- **CSRF & Exact Same-Origin Protection:**
  - Approval mutation route `POST /api/actions/[proposalId]/decision` enforces exact same-origin checks (`Sec-Fetch-Site: same-origin` and matching `Origin` against request origin URL including scheme, hostname, and port), rejecting cross-site submissions, cross-port origins, and scheme mismatches (`403 FORBIDDEN`).
  - Strict HTTP method gating: rejects `GET` on decision endpoints; requires `POST`.
  - Request body size is hard-capped at 16KB (16,384 bytes) to protect against payload flooding.
- **Fail-Closed Actor Resolution & Inspection Authorization:**
  - Canonical seeded operator alignment: Alice Walker (`10000000-0000-4000-8000-000000000011`, role `operator`).
  - `resolveTrustedActor` resolves the authenticated actor context server-side.
  - In non-production environments, demo actor fallback requires `NODE_ENV === 'test'` or (`NODE_ENV === 'development'` AND explicit opt-in `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR === 'true'`).
  - Production, staging, preview, and unconfigured environments strictly fail closed (`403 UNAUTHORIZED_ENVIRONMENT`).
  - Proposal review inspection endpoint (`GET /api/actions/[proposalId]`) resolves actor server-side, requiring `admin` or `operator` role (failing closed for unauthorized actors or environments).
  - Actor authorization before idempotency: approver tenant match and authoritative user existence/role checked prior to returning existing approval records.
- **Durable Store Availability & Fail-Closed Behavior:**
  - Prohibition of silent in-memory fallback: production/dev environments must connect to durable PostgreSQL or fail closed with 503 `ACTION_STORE_UNAVAILABLE`. In-memory context permitted only via explicit test injection (`setActionServerContextForTesting`).
- **Database Row-Level Concurrency & Locking:**
  - Approvals lock the proposal using `SELECT ... FOR UPDATE` before resolution.
  - Recomputes canonical parameter hash and approval binding fingerprint against persisted data.
  - Validates time window: `decidedAt < validUntil <= expiresAt` with bounded duration (`MAX_APPROVAL_VALIDITY_MS` = 30 days) and single captured clock instant.
  - Atomic idempotency handling: duplicate clicks with the same decision return the existing approval record idempotently; conflicting decisions fail with `409 CONFLICT`.
- **Public Error Masking (Zero Database/Stack Leaks):**
  - Route handlers catch and mask database errors, internal stacks, and connection strings, returning safe, generic client-facing messages (`INTERNAL_ERROR`, `FORBIDDEN`, `CONFLICT`, `ACTION_STORE_UNAVAILABLE`, etc.).
- **Zero Task Mutation in Approval Phase:**
  - In Phase 4.2, human approval resolution stopped strictly at `APPROVED` or `DENIED`; zero task mutations were performed prior to authorized Phase 4.3 execution.
  - Zero WRITE tools exist in MCP; model approval capability remains 0.

## Phase 4.3 Implemented Security Controls (Controlled Task Execution)

- **Zero WRITE MCP Tools:**
  - The model remains strictly READ / ANALYZE only.
  - Zero WRITE tools are exposed to or discoverable by the Strands operations agent.
  - The model NEVER executes actions, calls executors, or participates in execution.
- **Human Approval is the Sole Authority:**
  - The executor accepts ONLY the approved proposal ID (`proposalId`).
  - No caller-supplied parameters are accepted at execution time.
  - The executor reloads the frozen durable proposal and approval record directly from PostgreSQL within verified tenant scope.
- **Dual Durable Idempotency Barriers:**
  - Engine-level unique constraint `UNIQUE(action_executions.action_proposal_id)` prevents duplicate execution records.
  - Engine-level unique constraint `UNIQUE(tasks.source_action_proposal_id)` with composite foreign key prevents duplicate task creation across concurrent calls, retries, and restarts.
- **Comprehensive Single-Transaction Revalidation:**
  - Full execution sequence runs inside ONE PostgreSQL transaction with proposal row lock `SELECT ... FOR UPDATE`.
  - Revalidates proposal status (`APPROVED`), tenant match, non-expiration (`now() <= expiresAt` and `now() <= validUntil`).
  - Revalidates authoritative approver identity in `users(id, organization_id)` with role `admin` or `operator`.
  - Recomputes canonical parameter hash and approval binding hash against persisted data; drift fails closed with `APPROVAL_BINDING_MISMATCH`.
  - Revalidates entity relationships: `assigneeUserId` must exist in tenant (fails closed on `assigneeDisplayName` without ID), `projectId` belongs to client, `milestoneId` belongs to project.
  - Revalidates record-version preconditions: locks target project with `SELECT ... FOR SHARE` and verifies `updated_at` matches `expectedValue`.
- **Atomic State Transitions & Engine Triggers:**
  - Proposal transitions: `APPROVED -> EXECUTING -> COMPLETED` (or `FAILED` on mutation error, `EXPIRED` if past validity window).
  - Triggers enforce: initial execution state `EXECUTING`, authorization freeze on execution row, immutability of approval and audit rows, no DELETE on proposals/executions/approvals/audit.
- **Savepoint Error Recovery & Failure Sanitization:**
  - Business mutation is isolated with `SAVEPOINT task_mutation`.
  - Catchable mutation errors roll back to savepoint, update execution status to `FAILED` with stable `ExecutionErrorCode` and safe predefined summary, transition proposal to `FAILED`, append `EXECUTION_FAILED`, and commit terminal failure.
  - Zero raw error messages or stack traces persisted in execution records or audit logs; defense-in-depth sanitization bounds summaries to 500 characters and redacts secrets/paths.
  - Infrastructure/connection failures roll back entirely, leaving the proposal `APPROVED` for safe reconnection reconciliation without illegal state transitions.
- **Execution Audit Trail:**
  - `EXECUTION_STARTED`, `EXECUTION_COMPLETED`, `EXECUTION_FAILED`, and `ACTION_EXPIRED` appended with strict allowlisted schemas.

## Phase 5 cloud/security boundaries

### Phase 5.0 contract freeze (Completed / merged)

ADR 0006 froze authority preservation, server-to-server AWS authentication, memory non-authority, staging database safety, and hard evaluation gates.

### Phase 5.1 MCP data-plane controls (Implemented on branch / remote certification pending)

- **Authority preservation:** model-facing MCP remains READ/ANALYZE only. Human approval and trusted `task.create` execution are unchanged.
- **Explicit target mode:** `CLIENTOPS_DATABASE_TARGET` is exactly `local` or `staging`; no generic remote-database bypass exists.
- **Staging environment/workload gate:** staging requires `CLIENTOPS_ENVIRONMENT=staging`, `CLIENTOPS_DATABASE_WORKLOAD=mcp`, exact allowlisted host/database/user, and TLS.
- **Pool target pinning:** one process cannot silently reuse an already-created pool for a different validated target.
- **Least privilege:** staging MCP startup verifies exactly one direct `clientops_mcp_reader` membership and no additional direct role memberships, required SELECT access only on MCP business tables, zero SELECT on Phase 4 control-plane tables, zero INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privileges across protected tables, and zero CREATE privilege on `public`.
- **No control-plane reads by grant:** the staging group role receives SELECT only on the ten business tables and explicitly no access to `action_proposals`, `action_approvals`, `action_executions`, or `audit_events`.
- **No destructive remote seed/reset:** staging bootstrap uses a dedicated idempotent synthetic seed. Local `supabase/seed.sql`, `db:reset`, and `demo:reset` are not remote workflows.
- **No silent fallback:** configured MCP startup fails closed instead of switching to in-memory data when PostgreSQL configuration/access fails.
- **Error sanitization:** MCP tool failures expose bounded fixed text, not raw PostgreSQL/infrastructure exception details.
- **AgentCore ingress:** cloud MCP mode is machine-to-machine. Browser Origin requests are rejected by application code; managed Runtime ingress is intended to use IAM/SigV4.
- **Secrets:** staging database credentials remain server-side only and must not appear in source, PRs, reports, public responses, or logs.
- **Human identity / Memory:** production OIDC and AgentCore Memory remain later gated work and are not part of Phase 5.1.

Phase 5.1 remote staging + AgentCore MCP Runtime certification passed before PR #6 merged. See ADR 0006, `docs/PHASE5_CONTRACTS.md`, and `docs/PHASE5_1_RUNBOOK.md`. Phase 5.2.0 is now authorized for contract/authority freeze only; Phase 5.2.1+ remains separately gated.

## Phase 5.2.0 Agent Runtime / proposer security freeze

Phase 5.1 is remotely certified and merged. Phase 5.2.0 changes contracts/governance only and creates no Agent Runtime or proposer credentials.

The Phase 5.2 Agent Runtime security boundary is frozen as follows:

- HTTP AgentCore runtime only: Linux ARM64, Node.js 24, `0.0.0.0:8080`, `POST /invocations`, `GET /ping`.
- IAM/SigV4 remains the machine ingress boundary; browser-direct AgentCore invocation is prohibited.
- The remote agent may discover only the five existing READ/ANALYZE business tools through the certified MCP Runtime. `system.get_status` is diagnostic only.
- The request-local authoritative evidence resolver remains inside the Agent Runtime through proposal registration and is never serialized to callers.
- Until production identity is separately authorized, certification accepts only one exact configured synthetic organization/actor pair and rejects mismatches.
- Public responses are strict and may expose proposal metadata only at `PENDING_APPROVAL`.
- The future `clientops_agent_proposer` workload must be a separate least-privilege database identity.
- Database enforcement must independently limit proposer writes to initial `PROPOSED`, `PROPOSED -> PENDING_APPROVAL`, and the `ACTION_PROPOSED` / `APPROVAL_REQUESTED` audit events.
- The proposer must have zero approval, execution, task-mutation, schema-create, reset, truncate, delete-all, or destructive authority.
- Agent Runtime database credentials must come from Secrets Manager; plaintext `DATABASE_URL` is forbidden in AgentCore environment variables.
- AgentCore Memory and production identity remain out of scope.

See `docs/PHASE5_2_RUNBOOK.md`.

## Phase 5.2.2 proposer database authority

Phase 5.2.1 is certified and merged in PR #8. Phase 5.2.2 is the only currently authorized database expansion.

The Agent Runtime proposer database identity is separate from the Phase 5.1 MCP reader:

- group role: `clientops_agent_proposer`;
- staging LOGIN role: `clientops_agent_staging_login`;
- the LOGIN role has exactly one direct group membership and no elevated PostgreSQL attributes;
- `CREATE` on `public` is denied;
- direct sequence authority is denied.

The proposer may read only the authoritative records needed by grounded proposal registration: clients, projects, users, milestones, and action proposals.

Proposal writes are constrained both by PostgreSQL grants and triggers:

- column-scoped INSERT creates only `task.create` / `WRITE` / `PROPOSED`;
- UPDATE is granted only on `status` and `updated_at`;
- the proposer trigger permits only `PROPOSED -> PENDING_APPROVAL`;
- all authorization/evidence/parameter/tenant/correlation fields remain immutable;
- database request idempotency is enforced by unique `(organization_id, correlation_id)`;
- replay returns the existing proposal and does not append duplicate proposal-request audit events.

Audit authority is append-only and narrower than table read authority:

- column-scoped INSERT only;
- no proposer SELECT on `audit_events`;
- only `ACTION_PROPOSED` and `APPROVAL_REQUESTED`;
- no human actor ID;
- correlation and approval-binding hash must match the authoritative proposal;
- `ACTION_PROPOSED` parameter hash must also match.

The proposer has zero INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES authority on tasks, action approvals, or action executions and cannot transition proposals beyond `PENDING_APPROVAL`.

Cluster-level service roles stay in `supabase/staging`, outside normal local migrations. Passwords and connection strings are never committed. Live staging certification must use the exact `agent-proposer` target policy with verified TLS and must roll its synthetic proposal/audit rows back before completion.

Phase 5.2.2 does not authorize AgentCore Agent Runtime deployment, ECR, Memory, OIDC, production/customer database access, automatic approval/execution, or additional action types.
