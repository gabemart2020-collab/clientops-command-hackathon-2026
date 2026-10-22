# Architecture

**Architectural decision:** a TypeScript pnpm monorepo separates interface, orchestration, protocol, business rules, and persistence. See ADR 0001.

## Implemented architecture (Phases 1, 2 & 3)

```text
Human Operational Request ("Prepare me for tomorrow's Acme review.")
    ↓
Web Demo UI (Next.js 15 / React 19 Dual-Mode Harness)
    ↓
Server-Side API Route (/api/agent)
    ↓
ClientOpsAgent (packages/agent: Strands Agents TypeScript)
    ↓
Amazon Bedrock (Converse API / Claude 3.5 Sonnet / Nova)
    ↓ (Dynamic tool selection & sequence reasoning)
Native Strands McpClient (@strands-agents/sdk)
    ↓ (Strict 5-tool allowlist & Bedrock name normalization)
Streamable HTTP (2025-11-25 baseline over localhost /mcp)
    ↓
Process-Stateless MCP Service (services/mcp over Node 24 HTTP)
    ↓
Deterministic Domain Logic & Risk Rules (packages/domain)
    ↓
PostgreSQL / Supabase Schema (packages/data)
    ↓
authoritative facts + typed EvidenceRef
    ↓
Bedrock model synthesis (AgentBriefSchema)
    ↓
GroundingValidator (unsupportedEvidenceCount === 0)
    ↓
Web presentation with Evidence Drawers & Tool Execution Trace
```

### 1. Separation of Domain Truth vs. Generated Text (ADR 0004)

No business rule depends on model-generated text. Delivery health, overdue milestones, overdue tasks, overdue commitments, and unresolved inquiries are evaluated entirely by deterministic domain code (`packages/domain/src/rules/delivery-health.ts`). The model interprets human intent, selects tools, correlates cross-tool findings, and suggests operational next steps; it cannot alter deterministic calculations.

### 2. Runtime Grounding Validator & Zero-Hallucination Guarantee

Every risk finding emitted by the agent is cross-referenced by `GroundingValidator` against the exact set of `EvidenceRef` items observed from authoritative MCP tool responses during that invocation:

- All emitted entity IDs must match authoritative source records.
- Unsupported or hallucinated evidence references trigger an immediate failure state (`valid: false`).
- Zero hallucinated evidence (`unsupportedEvidenceCount === 0`) is enforced at the agent execution boundary before delivery to UI.

### 3. Strict Tool Allowlist & Fail-Closed Safety Boundary

The agent discovers tools over MCP but strictly filters them against an immutable allowlist of 5 authorized business read/analyze tools:

- `account.get_context` (`account_get_context`)
- `activity.get_recent` (`activity_get_recent`)
- `commitment.list_open` (`commitment_list_open`)
- `project.assess_delivery_health` (`project_assess_delivery_health`)
- `meeting.prepare_brief` (`meeting_prepare_brief`)

System tools (`system.get_status`) and any future Phase 4 write tools are denied via `BeforeToolCallEvent` hook interception, failing closed. Tool names are normalized to underscore format to satisfy Bedrock Converse API constraints while preserving wire-level dot notation.

### 4. Evidence Model

Every risk finding is strictly tied to an authoritative source record through typed `EvidenceRef` structures specifying `entityType`, `entityId`, `field`, and `excerpt`. Findings cannot exist without verifiable evidence.

### 5. Injectable Clock Abstraction

To guarantee the demonstration is not date-fragile, time evaluation uses an injectable `Clock` abstraction:

- `SystemClock`: Uses real system time (`new Date()`).
- `FixedClock`: Used in unit tests with explicit timestamps.
- `DemoScenarioClock`: Canonical Phase 2 timestamp (`2026-10-15T09:00:00.000Z`).

### 6. Tenant Isolation

All business repositories strictly require a server-provided `TenantContext` parameter (`{ organizationId: string }`). Tool arguments do NOT accept `organization_id` from client/model callers. All queries enforce tenant scoping at the SQL/store level.

### 7. Stateless MCP Transport Security (ADR 0002)

Node 24 HTTP serves `/mcp`, `/health`, and `/version`. Official `@modelcontextprotocol/server` and `@modelcontextprotocol/node` 2.1.0 implement Streamable HTTP through `createMcpHandler` and `toNodeHandler` with `legacy: 'stateless'` mode. Process memory owns no durable business state. Strict Host and Origin guards are enforced on every request.

## Phase 4 Controlled Action Approval Architecture (ADR 0003, ADR 0005)

Phase 4 moves ClientOps Command from a READ / ANALYZE agent to a full operational action lifecycle:

```text
UNDERSTAND → ASSESS → PLAN → RECOMMEND → PROPOSE ACTION
                                                ↓
                                         HUMAN APPROVAL (Trusted App Boundary)
                                                ↓
                                       EXECUTE (Trusted Server Executor)
                                                ↓
                                       VERIFY → AUDIT → REMEMBER
```

### 1. The Human Approval Trust Boundary

- **The LLM Never Approves Its Own Actions:** Model output is an untrusted suggestion, never authorization.
- **Approval Resolution is NEVER an MCP Tool:** Approval resolution lives strictly inside a trusted server application route outside the MCP protocol surface. Production authentication / identity-provider integration is not yet implemented; the current local demo actor is dev/test-only and fail-closed elsewhere.
- **Tool Discovery Separation:** The normal Strands operations agent discovers only authorized READ and ANALYZE tools (`account.get_context`, `activity.get_recent`, `commitment.list_open`, `project.assess_delivery_health`, `meeting.prepare_brief`). It does NOT discover WRITE tools.
- **Trusted Server Executor:** Approved actions are executed exclusively by the trusted server executor. The runtime receives only the approved proposal identifier (`{ proposalId }`) plus server-owned tenant/dependency context, reloads the frozen durable proposal from PostgreSQL, and revalidates all constraints before execution. No mutation parameters are accepted from the model or browser.
- **Immutable Approval Binding Fingerprint:** In addition to canonical parameter hashing (`computeCanonicalParameterHash`), execution validates the canonical `approvalBindingHash = SHA-256(canonicalize({ organizationId, actionType, parameters, preconditions, expiresAt }))`. Any parameter drift, precondition change, or expiration drift fails closed with `APPROVAL_BINDING_MISMATCH`.

### 2. 8-State Deterministic Action Lifecycle State Machine

```text
PROPOSED ──────────> PENDING_APPROVAL ──> APPROVED ──> EXECUTING ──> COMPLETED
     │                     │                  │             │
     │                     ├──> DENIED        └──> EXPIRED  └──> FAILED
     │                     │
     └──> EXPIRED          └──> EXPIRED
```

- Allowed transitions are strictly enforced by `packages/policy/src/state-machine.ts`:
  - `PROPOSED` → `PENDING_APPROVAL` | `EXPIRED`
  - `PENDING_APPROVAL` → `APPROVED` | `DENIED` | `EXPIRED`
  - `APPROVED` → `EXECUTING` | `EXPIRED`
  - `EXECUTING` → `COMPLETED` | `FAILED`
- `PROPOSED → DENIED` is explicitly forbidden. Human denial requires the action to be in `PENDING_APPROVAL` state. Policy denials occur prior to proposal registration and are not represented as human approval denials.
- Illegal transitions fail closed (e.g. `DENIED → APPROVED`, `EXPIRED → APPROVED`, `COMPLETED → EXECUTING`).
- Terminal states (`DENIED`, `EXPIRED`, `COMPLETED`, `FAILED`) have zero outbound transitions.
- Unknown action types deterministically evaluate to `DENIED` and `EXTERNAL`, never `WRITE` or `REQUIRES_APPROVAL`.

### 3. Proposal Evidence Architecture (Citation Pointers Only)

- Reusing the Phase 3 evidence grounding architecture: the untrusted model proposal input (`ModelActionProposalInput`) emits citation pointers only (`entityType`, `entityId`, optional `field`).
- Authoritative excerpts are hydrated server-side from the request-local authoritative evidence registry.
- Only canonical server-hydrated `EvidenceRef` records are persisted in the proposal.
- Fabricated, unknown, wrong-field, or ambiguous citations reject proposal registration immediately.

### 4. Record Version Semantics & TOCTOU Protection

Record version preconditions (`RecordVersionPrecondition`) bind strictly to existing entity schema timestamps:

- `versionField: 'updated_at'`
- `expectedValue: string` (ISO 8601 datetime)
- For `task.create`, the proposal binds at minimum to the target `project` record. Unsupported revision counters are not invented.

### 5. Idempotency & Single PostgreSQL Transaction Ownership

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

Prechecks outside the transaction (`validateExecutionPrecheck`) are advisory only. A database unique constraint on `action_executions(action_proposal_id)` prevents duplicate execution across concurrent requests, process restarts, or retries.

### 6. Append-Only Audit Trail with Strict Schemas

All lifecycle transitions produce immutable audit records:

- `ACTION_PROPOSED`, `APPROVAL_REQUESTED`, `ACTION_APPROVED`, `ACTION_DENIED`, `ACTION_EXPIRED`, `EXECUTION_STARTED`, `EXECUTION_COMPLETED`, `EXECUTION_FAILED`.
- Strict event-specific allowlisted schemas (`z.strictObject`) reject arbitrary model/provider payloads.
- Audit events never store raw prompts, chain-of-thought, raw exception objects, stack traces, credentials, or unbounded model text.
- Immutability is enforced at the PostgreSQL engine level via trigger preventing `UPDATE` and `DELETE`.
- Defense-in-depth sanitization strips `FORBIDDEN_AUDIT_KEYS`.

### 7. Trusted Actor Abstraction & Non-Production Guard

Production authentication is **planned**, not yet implemented. In Phase 4, the `TrustedActorContext` abstraction defines actor identity, tenant, and role.
For development and test environments, `createLocalDemoActorContext` is provided. It fails closed unless:

- `NODE_ENV` is strictly `'development'` or `'test'`.
- In development, the explicit opt-in flag `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true` is set.
  All other environments (production, staging, preview, undefined) fail closed with a security boundary error.

### 8. Durable Repositories & Transaction Client Injection (Phase 4.1, 4.1.1 & 4.1.2 Freeze)

Phase 4.1, 4.1.1, and 4.1.2 establish strongly-typed, tenant-isolated repositories for proposals, approvals, executions, and audit trails in `packages/domain` and `packages/data`:

- `ActionProposalRepository`: Tenant-scoped creation, lookup, compare-and-set status transitions, and pending listing. Proposals enforce grounded evidence (`evidence.length >= 1`), strict target project binding (`entityId == parameters.projectId`, `versionField == 'updated_at'`), and strict SHA-256 hash formats (`^[0-9a-f]{64}$`). DELETE is prohibited by trigger `trg_action_proposals_no_delete`.
- `ActionApprovalRepository`: Creation and lookup. Strictly prohibits and omits `update` and `delete` methods. Approvals enforce composite tenant actor relationship `(actor_id, organization_id) REFERENCES users(id, organization_id)`. Insertion is validated by trigger `trg_action_approvals_validate` ensuring: proposal exists and status is strictly `PENDING_APPROVAL`, proposal is not expired (`decided_at <= expires_at`), time interval is sound (`valid_until > decided_at` and `valid_until <= expires_at`), hashes match using NULL-safe comparison (`IS DISTINCT FROM`), authoritative user in `users(id, organization_id)` has role `admin` or `operator`, and snapshot `actor_role` matches authoritative user role. Immutability is enforced by `trg_action_approvals_immutable`.
- `ActionExecutionRepository`: Creation, lookup, and result updating. Enforces idempotency via `uq_action_executions_proposal`. Binds execution strictly to exact approval via composite foreign key `(action_approval_id, action_proposal_id, organization_id) REFERENCES action_approvals(id, action_proposal_id, organization_id)` with `action_approval_id NOT NULL`. Execution records server-owned executor identity (`executor_principal = 'clientops_trusted_executor'`), separating human authorization from execution. Trigger `trg_action_executions_freeze` freezes all authorization fields after insertion and enforces the execution state machine (`EXECUTING -> COMPLETED | FAILED`, terminal, rejecting self-transitions). Failures map known errors to stable codes (`ExecutionErrorCode`) and safe predefined summaries (`SAFE_FAILURE_SUMMARIES`), with unhandled errors defaulting to `INTERNAL_EXECUTION_ERROR`. Defense-in-depth sanitization bounds summaries to 500 characters and redacts secrets and paths. DELETE is prohibited by trigger `trg_action_executions_no_delete`.
- `AuditEventRepository`: Append and listing. Strictly prohibits and omits `update` and `delete` methods. Enforces composite foreign keys `(action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)` and `(actor_id, organization_id) REFERENCES users(id, organization_id)` preventing cross-tenant references. Immutability is enforced by `trg_audit_events_immutable`.

#### Transaction Client Injection Pattern

To ensure the future mutation executor can perform proposal locking, approval verification, idempotency reservation, task creation, proposal status transition, and audit logging inside **ONE PostgreSQL transaction**, all repository methods accept an optional `options?: RepositoryTransactionOptions` parameter:

```ts
export interface DbClient {
  query<R = any>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface RepositoryTransactionOptions {
  client?: DbClient;
}
```

When `client` is provided (e.g. an acquired `PoolClient` with `BEGIN`), the repository executes queries against that connection, allowing multiple repository operations to participate in the same atomic transaction. When omitted, queries execute against the default repository pool.

#### Infrastructure Failure, Savepoints, and Reconnect Reconciliation

PostgreSQL marks a transaction aborted upon encountering any unhandled SQL error. To guarantee engine-level consistency and audit durability:

1. **Infrastructure / Connection Failure (Transaction Abort):** If a network disconnect, crash, or unhandled SQL abort occurs during execution, the single PostgreSQL transaction rolls back entirely (`ROLLBACK;`).
   - Because the transaction rolls back, the durable database state of the proposal remains in its prior committed state: `APPROVED`.
   - The system does **NOT** manufacture an illegal `APPROVED -> FAILED` transition (the frozen state machine strictly forbids it: `APPROVED` may only transition to `EXECUTING` or `EXPIRED`).
   - Upon reconnection, reconciliation occurs safely by querying `approved_action_id` to determine whether an `action_executions` row was committed or if execution should be safely retried.
2. **Domain Mutation Failure (Catchable Error):** The executor wraps the task creation mutation in `SAVEPOINT task_mutation_sp;`.
   - On business mutation failure, the executor rolls back to the savepoint (`ROLLBACK TO SAVEPOINT task_mutation_sp;`).
   - The transaction remains valid, allowing the executor to mark execution `FAILED` (with sanitized `failure_summary`), transition the proposal from `EXECUTING` to `FAILED`, record the `EXECUTION_FAILED` audit event, and call `COMMIT;`.

### 9. Proposal Registration & Trusted Human Approval Boundary (Phase 4.2 Implemented)

Phase 4.2 implements the proposal registration service, trusted human approval boundary, secure web API routes, and minimal approval UI:

- **Grounded Proposal Registration (`registerActionProposal`):**
  - Accepts untrusted model suggestion `ModelActionProposalInput` containing citation pointers only.
  - Materializes canonical parameters (`materializeTaskCreateParameters`) and computes `computeCanonicalParameterHash`.
  - Verifies tenant isolation and validates client and project exist within the tenant.
  - Hydrates authoritative evidence excerpts from the request-local registry via `AuthoritativeEvidenceResolver`; fabricated or ambiguous citations reject registration immediately.
  - Derives target project `updated_at` precondition directly from the authoritative database record.
  - Enforces server-owned proposal TTL policy (default 24 hours) via injectable `Clock`; browser/model cannot supply `expiresAt`.
  - Derives canonical `approvalBindingHash`.
  - Executes within ONE atomic transaction: inserts proposal with initial status `PROPOSED`, appends `ACTION_PROPOSED` audit event, transitions status to `PENDING_APPROVAL`, and appends `APPROVAL_REQUESTED` audit event.

- **Trusted Human Approval Boundary (`resolveApprovalDecision`):**
  - Decision request schema (`ApprovalDecisionRequestSchema`) strictly requires `decision: 'APPROVE' | 'DENY'`, optional sanitized comment (max 500 characters). All extraneous fields (`actorId`, `organizationId`, `parameterHash`, `status`, etc.) are rejected with Zod schema validation errors.
  - Human actor context is resolved server-side (`resolveTrustedActor`), failing closed on untrusted or unauthenticated actors.
  - Proposal is locked with `SELECT ... FOR UPDATE` (or in-memory concurrency guard).
  - Revalidates tenant match, `PENDING_APPROVAL` status, non-expired proposal (`decidedAt <= expiresAt`), authoritative user in database with role `operator` or `admin` matching snapshot `actorRole`.
  - Recomputes canonical parameter hash and approval binding hash; any drift or tampering fails closed.
  - Bounds approval validity: `decidedAt < validUntil <= expiresAt` (default 24h validity).
  - Inserts immutable `ApprovalRecord`.
  - Transitions proposal to `APPROVED` or `DENIED`.
  - Appends `ACTION_APPROVED` or `ACTION_DENIED` with cross-field identity agreement.
  - Handles concurrent duplicates and idempotency retries: same decision returns existing approval idempotently; opposite decision throws 409 Conflict.
  - **Zero Task Mutation:** Strictly terminates at `APPROVED` or `DENIED`; no task rows created.

- **Web API Routes & UI (`apps/web`):**
  - `POST /api/actions/[proposalId]/decision`: CSRF same-origin check, 32KB request size limit, JSON validation, public error masking.
  - `GET /api/actions/[proposalId]`: Tenant-scoped sanitized proposal inspection for review (internal hashes, raw prompts, and credentials omitted).
  - `/actions/[proposalId]`: Minimal deterministic human approval UI page for human operators.

### 10. Controlled Execution of Approved `task.create` (Phase 4.3 Implemented)

Phase 4.3 implements the trusted server execution boundary for approved `task.create` proposals:

- **Zero WRITE MCP Tools:**
  - The model remains strictly READ / ANALYZE only.
  - Zero WRITE tools are registered with or discoverable by the Strands operations agent.
  - The model NEVER executes actions, calls executors, or participates in execution.
- **Human Approval is Durable Authority:**
  - Execution accepts only the approved proposal's ID (`{ proposalId }`).
  - The executor directly reloads the frozen durable `ActionProposal` and `ActionApproval` from PostgreSQL.
  - Revalidates all constraints deterministically before mutating state.
- **Single PostgreSQL Transaction Boundary:**
  - The trusted server executor (`executeApprovedAction`) executes the complete mutation sequence inside ONE PostgreSQL transaction:
    1. Lock proposal row with `SELECT ... FOR UPDATE`.
    2. Check idempotency: if already `COMPLETED`, returns existing task; if `FAILED`, returns execution failure; if `EXECUTING`, fails closed with conflict.
    3. Revalidate approval record: exists, status is `APPROVED`, matching proposal ID, matching tenant.
    4. Revalidate human approver: exists in `users(id, organization_id)` with role `admin` or `operator`.
    5. Revalidate validity periods: `now() <= expiresAt` and `now() <= validUntil`. (If expired, transitions `APPROVED -> EXPIRED` and appends `ACTION_EXPIRED`).
    6. Recompute `parameterHash` and `approvalBindingHash` and verify zero drift.
    7. Revalidate entity relationships: assignee user exists in tenant (if specified), project exists and belongs to client, milestone exists and belongs to project.
    8. Revalidate record-version preconditions: locks target project with `SELECT ... FOR SHARE` and verifies `updated_at` matches `expectedValue`.
    9. Transition proposal from `APPROVED` to `EXECUTING`.
    10. Reserve execution record (`status = 'EXECUTING'`, `executor_principal = 'clientops_trusted_executor'`).
    11. Append `EXECUTION_STARTED` audit event.
    12. Establish savepoint `SAVEPOINT task_mutation`.
    13. Insert business task row (`INSERT INTO tasks ...`) with `source_action_proposal_id`.
    14. Read back and verify exact fields against approved parameters.
    15. On catchable mutation failure: `ROLLBACK TO SAVEPOINT task_mutation`, mark execution `FAILED` (with bounded stable error code and safe predefined summary), transition proposal to `FAILED`, append `EXECUTION_FAILED` audit event, and commit terminal failure.
    16. On success: `RELEASE SAVEPOINT task_mutation`, update execution to `COMPLETED` with `target_entity_id`, transition proposal to `COMPLETED`, append `EXECUTION_COMPLETED` audit event, and commit.
- **Dual Durable Idempotency Barriers:**
  - Database unique constraint `UNIQUE(action_executions.action_proposal_id)` prevents duplicate execution records.
  - Database unique constraint `UNIQUE(tasks.source_action_proposal_id)` with composite foreign key prevents duplicate task creation across concurrent requests, process restarts, or retries.
- **Application Integration:**
  - In `POST /api/actions/[proposalId]/decision`, when human decision is `APPROVE`, the route automatically invokes `executeApprovedAction` and returns a structured response indicating approval and execution status (`COMPLETED`, `FAILED`, or `UNCONFIRMED`). On `DENY`, the executor is never invoked.
  - Action detail UI (`/actions/[proposalId]`) displays execution outcome (`TASK CREATED` with ID, `EXECUTION FAILED`, or `EXECUTION NOT CONFIRMED` with retry).

### 11. Task Due-Date Canonicalization & Temporal Readback Invariant (Phase 4.3.3 Implemented)

Phase 4.3.3 hardens temporal serialization between model-generated ISO timestamps and database driver representations:

1. **Pre-Persistence Canonicalization (`canonicalizeIsoDateTime`):**
   - When registering a proposal, `materializeTaskCreateParameters` canonicalizes `dueAt` to standard ISO 8601 UTC with full millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`) via `canonicalizeIsoDateTime`.
   - The model schema (`ModelActionProposalInputSchema`) remains tolerant of valid ISO datetime strings without milliseconds (e.g. `2026-10-16T09:00:00Z`), but the server canonicalizes the value _before_ computing `parameterHash`, deriving `approvalBindingHash`, persisting to PostgreSQL, and presenting to human operators for approval.
   - This ensures human approval binds the exact canonical representation.
2. **Temporal Instant Readback Verification (`sameOptionalInstant`):**
   - During Step 15 of `executeApprovedAction`, the task row read back from PostgreSQL (where `row.due_at` is serialized via `Date.toISOString()`) is compared against `proposal.parameters.dueAt` using `sameOptionalInstant`.
   - `sameOptionalInstant` compares temporal epoch milliseconds (`Date.getTime()`), ensuring equivalent temporal instants evaluate as equal regardless of string formatting differences, while non-equivalent timestamps (including 1 millisecond drifts) fail closed, triggering transaction rollback to savepoint.

## Phase certification status & Phase 5 cloud boundary

### Phase 4 Live Certification Status

- **Phase 4.2 live Bedrock proposal path:** CERTIFIED.
- **Phase 4.3 live controlled `task.create` mutation:** CERTIFIED.
  - Verified against Amazon Bedrock with strict human approval trust boundaries.
  - Exactly one task created on first `APPROVE`.
  - Idempotent `APPROVE` retry produced zero duplicate effects.
  - Model retained zero WRITE tools (strictly READ / ANALYZE tools only).
- **Phase 4 PR #4:** MERGED into `main` at `b07b294e232c48145c6a0d3e2c91635580c3b913`.

### Phase 5.0 — Cloud Trust Boundary & Contract Freeze (COMPLETED / MERGED)

Phase 5 makes ClientOps more deployable, persistent, measurable, and production-shaped without increasing the model's authority over business state.

Frozen topology:

```text
Browser
  |
  v
Trusted Next.js application boundary
  |  server-derived actor/tenant/session
  |  AWS-authenticated server-to-server invocation
  v
AgentCore Agent Runtime (planned)
  |  Strands + Bedrock
  |  request-local grounding
  |  proposal registration only
  v
AgentCore MCP Runtime (planned)
  |  MCP 2025-11-25
  |  READ / ANALYZE only
  v
PostgreSQL / Supabase authoritative truth

AgentCore Memory (planned)
  -> advisory continuity/preferences only
  -> never business truth/evidence/authorization

Human APPROVE / DENY + trusted executor
  -> remain outside MCP/model authority
```

Key frozen decisions:

- Node.js 24 remains the application runtime baseline.
- Planned AgentCore deployment uses custom Linux ARM64 containers rather than lowering the repository to the current AgentCore direct-code Node.js 22 runtime.
- Planned MCP cloud contract is `0.0.0.0:8000/mcp` with stateless Streamable HTTP; local default remains `127.0.0.1:3001/mcp`.
- Planned Agent Runtime contract is HTTP on port 8080 with `/invocations` and `/ping`.
- Browser-to-AgentCore direct invocation is prohibited; machine-to-machine transport is AWS-authenticated, initially IAM SigV4.
- The complete trust unit `agent invocation -> MCP evidence capture -> grounding -> proposal registration` moves together in future remote-agent mode so the authoritative request-local evidence resolver is never exposed as a generic remote/browser payload.
- Agent Runtime may create only proposal-control-plane state through `PENDING_APPROVAL`; it cannot approve, execute, or mutate tasks.
- AgentCore Memory is advisory only. Initial long-term scope is user/operator preferences, not business facts.
- Phase 5.0 froze the staging safety contract: exact allowlisted non-production target, TLS, workload-specific least privilege, additive migrations, and permanent prohibition of remote reset/drop/truncate.
- Phase 5.0 was merged in PR #5. Phase 5.1 is separately authorized.

Authoritative Phase 5 design records:

- `docs/adr/0006-agentcore-runtime-memory-boundaries.md`
- `docs/PHASE5_CONTRACTS.md`

### Phase 5.1 — Non-Production Data Plane & AgentCore MCP Runtime (IMPLEMENTED ON BRANCH / REMOTE CERTIFICATION PENDING)

Phase 5.1 implements only the model-facing data plane. It does not deploy the Agent Runtime and does not change human approval or trusted execution.

```text
Future Agent Runtime / approved AWS caller
          |
          | IAM/SigV4 at AgentCore ingress
          v
AgentCore MCP Runtime
  Node.js 24 / linux-arm64
  0.0.0.0:8000/mcp
  MCP 2025-11-25
  stateless Streamable HTTP
  browser Origin rejected
          |
          | TLS PostgreSQL
          | clientops_mcp_reader only
          v
Isolated synthetic staging PostgreSQL
  authoritative READ data
  zero proposal/approval/execution/task mutation privilege
```

Implemented boundaries:

- **Explicit database target:** `CLIENTOPS_DATABASE_TARGET=local|staging`. Local remains the default.
- **Exact staging guard:** staging requires `CLIENTOPS_ENVIRONMENT=staging`, `CLIENTOPS_DATABASE_WORKLOAD=mcp`, an exact configured host, exact configured database name, exact configured PostgreSQL username, and an accepted PostgreSQL TLS mode. There is no general remote-host bypass.
- **Pool target pinning:** once a process initializes a pool for one validated target, it rejects attempts to reuse that process for a different host/database target.
- **MCP reader privilege preflight:** before the configured staging MCP listener starts, the runtime verifies membership in `clientops_mcp_reader`, required SELECT access, zero mutation privileges across business/control-plane relations, and zero CREATE privilege on the public schema.
- **No silent data fallback:** configured MCP startup no longer converts database configuration/connectivity errors into in-memory demo data.
- **Bounded MCP errors:** business tool failures return fixed safe messages rather than raw database/infrastructure exception text.
- **Staging bootstrap separation:** cluster-level read-only role definition and the non-destructive synthetic seed live under `supabase/staging/`, outside normal local migrations/reset scripts. The remote seed contains no TRUNCATE/DELETE/DROP path.
- **AgentCore runtime mode:** the cloud configuration is pinned to Node.js 24, Linux ARM64, port 8000, `/mcp`, MCP 2025-11-25, and machine-to-machine traffic. Browser `Origin` requests are rejected by the application; AgentCore IAM/SigV4 is the managed external ingress authorization boundary.
- **Tool authority unchanged:** the runtime still exposes exactly one READ diagnostic tool plus five READ/ANALYZE business tools. No WRITE, approval, denial, or execution tool is introduced.

Remote AWS/staging certification is intentionally pending direct code review. See `docs/PHASE5_1_RUNBOOK.md`. Phase 5.2 remains unauthorized.
