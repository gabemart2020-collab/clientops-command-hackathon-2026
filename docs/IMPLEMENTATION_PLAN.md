# Implementation plan and gates

## Completed phases

### Phase 0 & 0.1 — Repository foundation

Created workspace, pinned pnpm 12.3.4, Node 24.x, governance documents, and initial CI workflow. Merged into `main`.

### Phase 1 — MCP protocol proof

Implemented local Streamable HTTP MCP service (baseline 2025-11-25) with `system.get_status`, Host/Origin security validation, loopback default binding, and smoke test. Merged into `main`.

### Phase 2 — Domain vertical slice

Implemented the ClientOps domain vertical slice proving deterministic business data flows end-to-end:

- Additive PostgreSQL schema (10 entities) and local Docker DB lifecycle (`pnpm db:start`, `pnpm db:reset`, `pnpm demo:reset`, `pnpm db:stop`).
- Deterministic demo seed data (Acme Labs hero + BetaCorp Org 2).
- Injectable clock abstraction (`DemoScenarioClock`: `2026-10-15T09:00:00.000Z`).
- Strict tenant context enforcement across all repositories and tools.
- Deterministic delivery-health risk rules and evidence references (`EvidenceRef`).
- 5 ClientOps business MCP tools over official `@modelcontextprotocol/client`.
- Next.js demo interface displaying client context, high-visibility "AT RISK" status, evidence-backed risk findings, open commitments, recent activity, talking points, and MCP protocol execution trace.
- 110 automated tests passing across 9 test files, including full-stack hero acceptance test (`tests/hero.test.ts`). Merged into `main`.

### Phase 3 — Agentic orchestration (Amazon Bedrock + Strands Agents TypeScript) (Completed)

Integrated Amazon Bedrock and Strands Agents TypeScript:

- Built the ClientOps operations agent using `@strands-agents/sdk`.
- Connected Strands native `McpClient` over Streamable HTTP (2025-11-25 baseline) to the ClientOps MCP service.
- Dynamic tool discovery and selection across authorized read/analyze tools (`account.get_context`, `activity.get_recent`, `commitment.list_open`, `project.assess_delivery_health`, `meeting.prepare_brief`).
- Enforced strict tool allowlist: unexpected tools and write tools intercepted and denied fail-closed via `BeforeToolCallEvent`.
- Runtime `GroundingValidator`: verified zero unsupported evidence references against authoritative records observed in the invocation.
- Certified 100% live against Amazon Bedrock (`us.anthropic.claude-sonnet-4-6`) across 6/6 evaluation scenarios. Merged into `main`.

### Phase 4 — Controlled action approval, policy, and append-only audit (Completed)

Transition ClientOps Command from a READ / ANALYZE agent to a full operational action lifecycle:
UNDERSTAND → ASSESS → PLAN → RECOMMEND → PROPOSE ACTION → HUMAN APPROVAL → EXECUTE → VERIFY → AUDIT → REMEMBER

Branch: `phase/4-controlled-action-approval`
Authorized vertical slice: `task.create`

#### Phase 4.0 / 4.0.1 — Trust Boundary, Architecture, Contracts and Governance Freeze (Completed)

- Freeze trust boundary: LLM is an untrusted proposer and never approves its own actions.
- Approval resolution occurs strictly through a trusted server application boundary outside MCP (ADR 0003, ADR 0005).
- Normal Strands agent discovers only READ/ANALYZE tools; does not discover WRITE tools.
- Implement strongly typed Zod contracts (`packages/contracts`) for action proposals, parameters, approvals, execution authorizations, execution results, and allowlisted audit events.
- Implement pure, deterministic policy engine (`packages/policy`) classifying actions and evaluating permission (READ/ANALYZE/DRAFT: automatic allow, WRITE: requires approval, EXTERNAL/DESTRUCTIVE: denied, Unknown actions: deterministically DENIED).
- Implement 8-state deterministic action lifecycle state machine (`PROPOSED` → `PENDING_APPROVAL` | `EXPIRED`; `PENDING_APPROVAL` → `APPROVED` | `DENIED` | `EXPIRED`; `APPROVED` → `EXECUTING` | `EXPIRED`; `EXECUTING` → `COMPLETED` | `FAILED`). `PROPOSED -> DENIED` removed; human denial requires `PENDING_APPROVAL`.
- Implement `approvalBindingHash = SHA-256(canonicalize({ organizationId, actionType, parameters, preconditions, expiresAt }))` revalidated at execution.
- Implement authoritative record-version semantics: `versionField: 'updated_at'` bound at minimum to `project`.
- Implement proposal evidence resolution reusing Phase 3 architecture: untrusted model proposal emits citation pointers only; authoritative excerpts hydrated server-side; fabricated or ambiguous citations reject registration.
- Implement `TrustedActorContext` with `createLocalDemoActorContext` failing closed unless `NODE_ENV` is strictly `development` or `test` and `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true` in development. Production auth is planned.
- Freeze transaction ownership: authoritative execution validation and mutation occur inside ONE PostgreSQL transaction owned by the mutating component (`SELECT ... FOR UPDATE`, check binding hash, verify preconditions, idempotency check, task creation, read-back, audit append, commit). Prechecks are advisory only.
- Implement append-only audit event builder with strict allowlisted payload schemas and database-level immutability trigger definition (`packages/audit`).
- Freeze 12 security gate tests offline with 0 violations.

#### Phase 4.1, Phase 4.1.1, Phase 4.1.2 & Phase 4.1.3 — Persistence Schema, Durable Repositories & Invariant Freeze (Completed)

- Implemented additive migration `supabase/migrations/20261005120000_phase4_controlled_action_approval.sql` creating:
  - `action_proposals` with `uq_action_proposals_id_org` unique constraint, grounded evidence/precondition CHECK constraints for `task.create`, strict hash regex CHECK constraints (`^[0-9a-f]{64}$`), `trg_action_proposals_initial_status` trigger enforcing initial status `PROPOSED` on INSERT, `trg_action_proposals_freeze` trigger enforcing immutability of authorization-critical fields and legal state transitions, and `trg_action_proposals_no_delete` trigger preventing deletion.
  - `action_approvals` with composite foreign key `(action_proposal_id, organization_id)`, actor composite foreign key `(actor_id, organization_id) REFERENCES users(id, organization_id)`, unique constraints `uq_action_approvals_proposal` and `uq_action_approvals_id_proposal_org`, `trg_action_approvals_validate` trigger enforcing proposal status, expiration, sound validity interval (`valid_until > decided_at` and `<= expires_at`), NULL-safe hash equality, authoritative user role (`admin` or `operator`), and exact snapshot role match; and `trg_action_approvals_immutable` trigger.
  - `action_executions` with composite foreign key `(action_approval_id, action_proposal_id, organization_id) REFERENCES action_approvals(id, action_proposal_id, organization_id)` (`action_approval_id NOT NULL`), server-owned `executor_principal = 'clientops_trusted_executor'`, bounded `failure_summary` (<= 500 chars), idempotency unique constraint `uq_action_executions_proposal`, `trg_action_executions_initial_state` trigger enforcing initial status `EXECUTING` and strictly NULL terminal fields on INSERT, `trg_action_executions_freeze` trigger freezing all authorization fields and enforcing execution status state transitions (`EXECUTING -> COMPLETED | FAILED`, terminal, rejecting self-transitions), and `trg_action_executions_no_delete` trigger.
  - `audit_events` with composite foreign keys `(action_proposal_id, organization_id)` and `(actor_id, organization_id) REFERENCES users(id, organization_id)`, `trg_audit_events_validate` trigger enforcing approver/denier roles (`admin`, `operator`) on INSERT, and `trg_audit_events_immutable` trigger rejecting `UPDATE` and `DELETE`.
  - Enforced `ON DELETE RESTRICT` across all references.
- Implemented strongly typed repositories in `packages/domain` and `packages/data`:
  - `PostgresActionProposalRepository` & `InMemoryActionProposalRepository` (enforcing initial status `PROPOSED`)
  - `PostgresActionApprovalRepository` & `InMemoryActionApprovalRepository` (strictly omitting `update` and `delete`, enforcing proposal existence, PENDING_APPROVAL status, non-expired status, valid intervals, user role authorization, and hash equality)
  - `PostgresActionExecutionRepository` & `InMemoryActionExecutionRepository` (binding execution to exact approval, forcing server executor principal, initial `EXECUTING` status with null terminal fields, state machine transition enforcement, and safe failure summary persistence)
  - `PostgresAuditEventRepository` & `InMemoryAuditEventRepository` (strictly omitting `update` and `delete`, enforced discriminated union schemas)
- Implemented transaction client injection (`options?: RepositoryTransactionOptions`) allowing multiple repository operations to execute atomically inside a single caller-owned PostgreSQL transaction.
- Documented execution failure semantics: transaction rollback leaves proposal `APPROVED` without manufactured `APPROVED -> FAILED` transition; reconnect reconciliation queries `approved_action_id`; `SAVEPOINT task_mutation_sp;` handles catchable mutation errors.
- Established Safe Failure Persistence Contract: `ExecutionErrorCode` and `SAFE_FAILURE_SUMMARIES` define bounded stable codes and predefined messages, with `INTERNAL_EXECUTION_ERROR` fallback and defense-in-depth sanitization.
- Aligned execution precheck with trust architecture: validates durable `approvalRecord.actorRole` and `approvalRecord.organizationId`; fails closed on missing/mismatched record versions or inactive project (`TOCTOU_PRECONDITION_FAILED`).
- Added root `test:data` script in `package.json`.
- Implemented 49 deterministic integration and unit test scenarios in `packages/data/src/action-repositories.test.ts` (including complete 64-pair 8x8 state transition matrix test, initial status trigger tests, execution authorization freeze tests, authoritative actor role validation, complete time validity checks, target project precondition binding, cross-tenant audit proof, and safe failure persistence tests) passing with 100% success.

#### Phase 4.2 / 4.2.1 — Proposal Registration & Trusted Human Approval Boundary (Completed)

- **Proposal Registration (`registerActionProposal`):**
  - Grounded registration of `task.create` proposals: untrusted model inputs emit citation pointers only, authoritative excerpts hydrated server-side from local evidence registry.
  - Server-owned 24h default TTL via injectable `Clock` and bounded `MAX_PROPOSAL_TTL_MS` (30 days); browser/model cannot supply `expiresAt`.
  - Canonical parameters materialized (`materializeTaskCreateParameters`) and SHA-256 parameter hash computed.
  - Server derives target project `updated_at` precondition directly from database record.
  - Mandatory `TransactionRunner` enforcing single PostgreSQL transaction: inserts proposal with initial status `PROPOSED`, appends `ACTION_PROPOSED`, transitions to `PENDING_APPROVAL`, appends `APPROVAL_REQUESTED`.
- **Trusted Human Approval Boundary (`resolveApprovalDecision`):**
  - Strict decision schema (`ApprovalDecisionRequestSchema = { decision: 'APPROVE' | 'DENY', comment?: string (max 500) }`), path-bound proposal ID, rejecting any extraneous or client-supplied trusted fields.
  - Canonical seeded operator alignment: Alice Walker (`10000000-0000-4000-8000-000000000011`, role `operator`).
  - Fail-closed actor resolution (`resolveTrustedActor` / `createLocalDemoActorContext`), requiring explicit dev opt-in (`CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true`) and failing closed in production.
  - Actor authorization verified before idempotency: approver tenant match and authoritative user existence/role checked prior to returning existing approval records.
  - Single captured clock instant and strictly bounded validity duration (`MAX_APPROVAL_VALIDITY_MS` = 30 days, capped at proposal `expiresAt`).
  - Atomic approval transaction with row-level locking (`SELECT ... FOR UPDATE`), tenant match, non-expired checks, parameter and binding hash recomputation, validity period windowing, immutable `ApprovalRecord` insertion, status transition to `APPROVED` or `DENIED`, and append of `ACTION_APPROVED` or `ACTION_DENIED` with cross-field identity agreement.
  - Idempotency & race handling: identical decision retries succeed idempotently; conflicting decisions return 409 Conflict; concurrent duplicates result in one immutable approval.
  - Zero task mutation: strictly stops at `APPROVED` or `DENIED`; zero task rows created; zero executions.
- **Web Routes & UI (`apps/web`):**
  - Removal of silent in-memory fallback in `getActionServerContext`: production/dev must connect to durable PostgreSQL or fail closed with 503 `ACTION_STORE_UNAVAILABLE`. In-memory context permitted only via explicit test injection (`setActionServerContextForTesting`).
  - `POST /api/actions/[proposalId]/decision`: Exact same-origin CSRF enforcement (strict scheme + host + port match; rejecting cross-port/cross-scheme), 16KB request size limit, JSON validation, public error masking.
  - `GET /api/actions/[proposalId]`: Protected endpoint with server-side actor resolution requiring `admin` or `operator` role; returns tenant-scoped sanitized proposal inspection (internal hashes, raw prompts, and credentials omitted).
  - `/actions/[proposalId]`: Minimal deterministic human approval UI page (`'use client'`).
  - Integration with Strands agent output: typed handoff (`proposedAction` + request-local `evidenceResolver`) -> `registerActionProposal` -> `actionProposal: { proposalId, status, reviewUrl }`.
- Test suite checkpoint (Phase 4.2.1): 374 offline tests across 20 test files, including full end-to-end PostgreSQL lifecycle suite (`action-approval-postgres-e2e.test.ts`) verifying APPROVE and DENY paths with zero task mutations and zero executions.
- **Phase 4.2 Live Bedrock Proposal Certification (Completed / Certified):** Successfully certified end-to-end live Bedrock invocation (`/api/agent` -> Strands -> Bedrock -> READ/ANALYZE tools -> structured `action_proposal` -> durable `PENDING_APPROVAL` in PostgreSQL).

#### Phase 4.3 — Controlled Task Execution & Verification (Completed)

Phase 4.3 implements controlled, trusted execution of approved `task.create` proposals:

- **Zero WRITE MCP Tools:**
  - The model remains strictly READ / ANALYZE only. Zero WRITE tools are registered with or exposed to the Strands operations agent. The model never executes actions.
- **Trusted Server Executor (`executeApprovedAction`):**
  - Accepts ONLY `{ proposalId }` (the approved action proposal identifier). Model or caller cannot pass mutation parameters at execution time.
  - Frozen proposal and approval records reloaded directly from PostgreSQL within verified tenant scope.
- **Single PostgreSQL Transaction Boundary:**
  - Locks proposal with `SELECT ... FOR UPDATE`.
  - Idempotency reconciliation: `COMPLETED` returns existing task; `FAILED` returns failure; `EXECUTING` throws conflict.
  - Revalidates approval record: exists, `APPROVED`, matching proposal, matching tenant.
  - Revalidates human approver: exists in `users(id, organization_id)` with role `admin` or `operator`.
  - Revalidates time validity: `now() <= expiresAt` and `now() <= validUntil`. Transitions `APPROVED -> EXPIRED` and appends `ACTION_EXPIRED` if expired.
  - Recomputes and verifies zero drift on `parameterHash` and `approvalBindingHash`.
  - Revalidates entity relationships: `assigneeUserId` in tenant (fails closed if `assigneeDisplayName` provided without ID), `projectId` belongs to client, `milestoneId` belongs to project.
  - Revalidates TOCTOU record-version preconditions: locks target project with `SELECT ... FOR SHARE` and verifies `updated_at` matches `expectedValue`.
  - State machine transitions: `APPROVED -> EXECUTING`, reserves execution record (`status = 'EXECUTING'`, `executor_principal = 'clientops_trusted_executor'`), appends `EXECUTION_STARTED`.
  - Savepoint error handling: `SAVEPOINT task_mutation` isolates task creation. Catchable errors roll back to savepoint, update execution and proposal to `FAILED` with safe failure summary, append `EXECUTION_FAILED`, and commit terminal failure. Unrecoverable infrastructure errors roll back entirely, leaving proposal `APPROVED` for safe reconnect reconciliation.
  - Success path: releases savepoint, updates execution to `COMPLETED` with `target_entity_id`, transitions proposal to `COMPLETED`, appends `EXECUTION_COMPLETED`, and commits transaction.
- **Additive Database Schema (`20261008120000_phase4_controlled_task_execution.sql`):**
  - Added `tasks.description`, `tasks.priority` with check constraint, `tasks.source_action_proposal_id` with unique constraint and tenant composite foreign key.
  - Added terminal shape check constraint on `action_executions`.
  - Enforced dual durable idempotency barriers: `UNIQUE(action_executions.action_proposal_id)` and `UNIQUE(tasks.source_action_proposal_id)`.
- **Web Layer Integration & UI:**
  - `POST /api/actions/[proposalId]/decision`: on `APPROVE`, runs `executeApprovedAction` and returns structured response (`COMPLETED`, `FAILED`, `BLOCKED`, `EXPIRED`, or `UNCONFIRMED`). On `DENY`, never invokes executor.
  - UI at `/actions/[proposalId]` updated to render task created result, execution failure, or unconfirmed retry.

#### Phase 4.3.1, 4.3.2 & 4.3.3 Hardening Passes (Completed)

- **Phase 4.3.1 (Transaction & Reconciliation Hardening):** Fixed durable expiration so `APPROVED -> EXPIRED` transitions and `ACTION_EXPIRED` audit events commit durably rather than rolling back. Streamlined task mutation contract to domain fields with server-owned UUID and status derivation. Added typed `BLOCKED` responses on decision route.
- **Phase 4.3.2 (Final Live-Readiness Hardening):** Wired authoritative `userRepository` and `milestoneRepository` into real `/api/agent` route path. Enforced fail-closed optional entity validation. Hardened durable terminal reconciliation with strict invariant checks. Masked internal exception text from decision route.
- **Phase 4.3.3 (Task Due-Date Canonicalization & Readback Hardening):** Implemented server-side `canonicalizeIsoDateTime` normalizing `dueAt` to canonical ISO 8601 UTC at JavaScript millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`) during parameter materialization prior to hash derivation, persistence, and human review. Implemented `sameOptionalInstant` comparing temporal epoch milliseconds (`Date.getTime()`) during readback verification, eliminating string-formatting false mismatches while strictly detecting genuine instant drift (including 1 millisecond).
- **Phase 4.3 Live Bedrock Execution Certification (Completed / Certified):** Successfully verified complete live controlled-action lifecycle against Amazon Bedrock:
  - Model invoked READ/ANALYZE tools only.
  - Grounded `task.create` proposal registered in `PENDING_APPROVAL`.
  - Human review endpoint inspected canonical frozen parameters.
  - Human `APPROVE` decision triggered private server executor.
  - Exactly one business task created.
  - Proposal and execution transitioned to `COMPLETED`.
  - Exactly 5 audit events recorded in order (`ACTION_PROPOSED`, `APPROVAL_REQUESTED`, `ACTION_APPROVED`, `EXECUTION_STARTED`, `EXECUTION_COMPLETED`).
  - Idempotent `APPROVE` retry returned identical task ID with zero duplicate effects.

### Current Implementation State & Final Validation Totals

- **Phase 4 Status:** COMPLETE, LIVE CERTIFIED, and MERGED in PR #4. `main` Phase 4 baseline: `b07b294e232c48145c6a0d3e2c91635580c3b913`.
- **Current Final Validation Totals:** 456 passing tests across 21 test files, including 10 passing real PostgreSQL E2E tests (`action-approval-postgres-e2e.test.ts`).

## Phase 5 — Cloud Runtime, Memory, Identity, and Evaluation

Phase 5 preserves the Phase 4 authority model. The model remains READ/ANALYZE + grounded proposal only; human approval and private trusted execution remain separate.

### Phase 5.0 — Cloud Trust Boundary & Contract Freeze (Completed / Merged)

Merged in PR #5 from `phase/5-agentcore-foundation`.

Authorized scope:

- Update post-merge governance and Phase 5 architecture documentation.
- Accept ADR 0006 for AgentCore Runtime, AgentCore Memory, human identity, cloud data, observability, and evaluation boundaries.
- Freeze versioned server-to-server invocation contracts in `docs/PHASE5_CONTRACTS.md`.
- Freeze future AgentCore container requirements while preserving Node.js 24.
- Freeze database workload-role separation and exact staging-target safety policy.
- Freeze memory authority: advisory continuity/preferences only; never business truth, evidence, identity, approval, or authorization.
- Freeze Phase 5 hard evaluation gates.

Phase 5.0 froze contracts only and created no AWS/database resources.

### Phase 5.1 — Non-Production Cloud Data Safety & AgentCore MCP Runtime (COMPLETED / REMOTELY CERTIFIED / MERGED)

Branch: `phase/5.1-agentcore-mcp-runtime`

Implemented on the branch:

- Explicit `CLIENTOPS_DATABASE_TARGET=local|staging` safety policy.
- Staging requires `CLIENTOPS_ENVIRONMENT=staging`, `CLIENTOPS_DATABASE_WORKLOAD=mcp`, exact allowlisted host/database/user, and TLS; there is no generic remote-database bypass.
- Local `db:reset` / `demo:reset` remain unchanged and local-only.
- Staging MCP read-only group role definition under `supabase/staging/001_clientops_mcp_reader.sql`.
- Non-destructive synthetic staging seed under `supabase/staging/002_clientops_demo_seed.sql`; remote `supabase/seed.sql` is forbidden because it contains `TRUNCATE`.
- Runtime MCP staging preflight verifies `clientops_mcp_reader` membership, required SELECT access, zero mutation privileges across business/control-plane tables, and zero CREATE privilege on the public schema before the listener starts.
- AgentCore MCP runtime mode freezes Node.js 24, Linux ARM64, `0.0.0.0:8000/mcp`, stateless Streamable HTTP, and protocol baseline 2025-11-25.
- AgentCore runtime mode rejects browser Origin requests and relies on AgentCore IAM/SigV4 as the managed external ingress authorization boundary.
- Default MCP service no longer silently falls back to in-memory data when configured PostgreSQL safety validation fails.
- MCP tool errors are bounded/sanitized rather than returning raw infrastructure exception strings.
- `docs/PHASE5_1_RUNBOOK.md` defines staging provisioning, image build/push, runtime deployment, remote tool certification, database immutability checks, and stop boundaries.

Phase 5.1 closure passed: isolated staging, reader-role preflight, exact ARM64 image, AgentCore MCP Runtime deployment, MCP 2025-11-25 remote tool certification, tenant isolation, zero database mutation, mutation denial, MMDSv2, and leak checks all passed before PR #6 merged.

Not authorized in Phase 5.1:

- AgentCore Agent Runtime;
- AgentCore Memory;
- production OIDC/Cognito;
- production/customer databases;
- new business action types;
- WRITE/approval/execution MCP tools;
- EXTERNAL/DESTRUCTIVE actions.

### Phase 5.2 — AgentCore Agent Runtime & Remote Proposal Path

#### Phase 5.2.0 — Contract & Authority Freeze (COMPLETED / MERGED PR #7)

Branch: `phase/5.2-agent-runtime-proposal-path`

Authorized:

- executable V1 request/response contracts;
- HTTP Agent Runtime / ARM64 Node.js 24 contract;
- exact five model-facing READ/ANALYZE tools;
- certification identity allowlist contract;
- Agent -> MCP IAM/SigV4 design;
- proposer database authority design and required DB enforcement;
- runbook/governance/evaluation/security updates;
- regression tests.

Not authorized in 5.2.0:

- Agent Runtime application or AWS deployment;
- ECR image/repository creation for the Agent Runtime;
- proposer PostgreSQL role/trigger/login provisioning;
- proposer Secrets Manager value creation;
- AgentCore Memory;
- production OIDC;
- expanded action/model authority.

#### Phase 5.2.1 — Agent Runtime application (COMPLETED / CERTIFIED / MERGED PR #8)

Branch: `phase/5.2.1-agent-runtime-application`

Implemented locally/offline:

- new `@clientops/agent-runtime` workspace;
- AgentCore HTTP `/ping` and `/invocations` boundary;
- strict V1 contracts and exact certification identity guard;
- exact certified remote MCP catalog assertion;
- AgentCore JSON-RPC/SSE MCP adapter behind injected data-plane invoker;
- existing `ClientOpsAgent` reuse;
- injected proposal-registration seam with no real proposer persistence yet;
- bounded errors/logging, body-size cap, browser-Origin rejection, graceful shutdown;
- offline boundary tests.

Explicitly not authorized in 5.2.1: AWS Agent Runtime/ECR deployment, proposer PostgreSQL roles/triggers/login, proposer secret, staging mutation, Memory, OIDC, new action types, or model WRITE authority.

#### Phase 5.2.2 — Proposer database boundary & staging privilege certification (AUTHORIZED CURRENT SUBPHASE)

Branch: `phase/5.2.2-proposer-database-boundary`

Authorized scope:

- requestId/correlation durable idempotency;
- proposer PostgreSQL group/login role;
- exact column/table grants and database-enforced lifecycle/audit restrictions;
- explicit `agent-proposer` staging target policy and privilege preflight;
- real PostgreSQL proposal registrar;
- dedicated proposer database secret;
- rollback-safe live staging allowed/denied privilege certification.

Explicitly out of scope: AgentCore Agent Runtime/ECR deployment, concrete AgentCore data-plane runtime binding, Memory, production OIDC, production/customer DB access, additional action types, or model WRITE/approval/execution authority.

#### Phase 5.2.3+ — GATED

Planned sequence:

- 5.2.3 AWS Agent Runtime data-plane binding and deployment;
- 5.2.4 remote grounded proposal-path certification.

### Phase 5.3 — AgentCore Memory (GATED)

Planned only; requires separate explicit authorization.

- Add explicit memory adapter.
- Short-term conversational continuity.
- Long-term user/operator preference strategy only.
- Organization/actor/session isolation with server-derived identifiers.
- Prove zero memory-as-business-evidence and zero cross-tenant memory leakage.

### Phase 5.4 — Production Human Identity Boundary (GATED)

Planned only; requires separate explicit authorization.

- Add OIDC identity provider (AWS Cognito is the current preferred candidate, not yet implemented).
- Map authenticated user to internal actor/organization server-side.
- Remove local demo actor from any production-shaped environment.
- Re-certify approval boundary and cross-tenant denial.

### Phase 5.5 — Observability, Evaluations & Full Cloud Certification (GATED)

Planned only; requires separate explicit authorization.

- Correlate web -> Agent Runtime -> MCP Runtime -> proposal/approval/execution/task with bounded telemetry.
- Add deterministic cloud/local parity suite.
- Layer AgentCore/LLM quality evaluators over hard security invariants.
- Measure latency, tokens, cold starts, and cost without inventing pre-baseline thresholds.
- Run full cloud controlled-mutation certification.

No later Phase 5 subphase is implicitly authorized. Phase 5.2.2 does not authorize Phase 5.2.3+, Memory, production identity, AgentCore/ECR deployment, or new business authority.
