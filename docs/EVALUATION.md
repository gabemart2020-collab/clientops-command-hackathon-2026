# Evaluation strategy

**Current configured validation (Phase 5.2.0 contract-review gate):**
Prettier checks formatting, ESLint enforces zero warnings, TypeScript verifies root and all workspace packages, and Vitest covers contracts, domain rules, persistence, MCP protocol/security, agent orchestration/grounding, proposal registration, trusted human approval, controlled execution, Phase 5.1 staging/runtime safety, and the Phase 5.2 Agent Runtime V1 authority envelope. `pnpm validate` composes formatting, linting, typechecking, all Vitest tests, and the compiled MCP smoke test. Hosted CI additionally runs `pnpm build:web` as a required production Next.js build check.

## Automated test matrix

| Test Suite                        | File                                                | Tests | Coverage                                                                                             |
| --------------------------------- | --------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| Agentic Orchestration             | `packages/agent/tests/offline.test.ts`              | 59    | Model config, READ/ANALYZE allowlist, grounding, proposal-mode contract, trace redaction             |
| Bootstrap invariants              | `tests/bootstrap.test.ts`                           | 12    | Package structure, governance, configuration invariants                                              |
| Hero Acceptance                   | `tests/hero.test.ts`                                | 4     | Acme hero path and cross-tenant isolation                                                            |
| MCP Protocol & Security           | `services/mcp/src/protocol.test.ts`                 | 36    | Streamable HTTP 2025-11-25, Host/Origin guards, payload bounds, AgentCore ingress mode               |
| MCP Business Tools                | `services/mcp/src/business.test.ts`                 | 8     | Six registered READ/ANALYZE tools total (1 diagnostic + 5 business), zero WRITE/approval discovery   |
| MCP Configuration                 | `services/mcp/src/config.test.ts`                   | 26    | Local/AgentCore configuration parsing and fail-closed runtime validation                             |
| Data Repositories & Safety        | `packages/data/src/data.test.ts`                    | 20    | Tenant isolation, local DB safety, repository behavior                                               |
| Action Repository / DB Invariants | `packages/data/src/action-repositories.test.ts`     | 49    | Proposal/approval/execution/audit repositories, state-machine parity, DB constraints                 |
| Web Orchestrator                  | `apps/web/src/orchestrator.test.ts`                 | 3     | Deterministic orchestration and MCP-unavailable handling                                             |
| Agent Route                       | `apps/web/src/agent-route.test.ts`                  | 22    | Agent HTTP lifecycle, action-proposal handoff, sanitization, assignee/milestone validation           |
| Action Routes                     | `apps/web/src/action-routes.test.ts`                | 21    | Review/decision routes, auth boundary, same-origin checks, bounded errors                            |
| PostgreSQL Approval/Execution E2E | `apps/web/src/action-approval-postgres-e2e.test.ts` | 10    | APPROVE/DENY, SAVEPOINT recovery, outer rollback, expiry, reconciliation, exactly-once task creation |
| Domain Rules & Clock              | `packages/domain/src/domain.test.ts`                | 9     | Delivery-health rules, talking points, clock abstraction                                             |
| Contracts & Agent Brief           | `packages/contracts/src/contracts.test.ts`          | 17    | Shared Zod contracts and brief invariants                                                            |
| Action Contracts                  | `packages/contracts/src/action.test.ts`             | 49    | Action schemas, hashes, datetime canonicalization, temporal equivalence                              |
| Policy Gates                      | `packages/policy/src/policy.test.ts`                | 29    | Action classification and frozen security gates                                                      |
| Proposal Service                  | `packages/policy/src/proposal-service.test.ts`      | 16    | Grounded registration, TTL, evidence, entity validation                                              |
| Approval Service                  | `packages/policy/src/approval-service.test.ts`      | 22    | Human decision authorization, validity, idempotency                                                  |
| Execution Service                 | `packages/policy/src/execution-service.test.ts`     | 35    | Transaction-bound execution, reconciliation, exact readback, failure semantics                       |
| Audit                             | `packages/audit/src/audit.test.ts`                  | 15    | Strict event payloads, redaction, append-only helpers                                                |
| MCP Name Normalization            | `packages/agent/tests/mcp-normalization.test.ts`    | 3     | Bedrock/MCP tool-name normalization                                                                  |
| Phase 5.1 Staging Policy          | `packages/data/src/db/phase5-staging.test.ts`       | 19    | Exact staging target/TLS/workload guards, pool identity, reader privilege preflight                  |
| Phase 5.1 PostgreSQL Reader       | `packages/data/src/phase5-staging-postgres.test.ts` | 3     | Real PostgreSQL reader-role certification, control-plane denial, mutation denial                     |
| Phase 5.1 AgentCore Contract      | `tests/phase5-agentcore-mcp.test.ts`                | 2     | ARM64/Node 24 container contract and non-destructive staging deployment artifacts                    |

Phase 5.2.0 adds `packages/contracts/src/agent-runtime.test.ts`; hosted CI is the authoritative source for the exact current test total.

## Live evaluation and certification

### Phase 3 — Agentic orchestration

The six-scenario Bedrock evaluation established the Phase 3 read/analyze orchestration baseline. The historical `pnpm eval:agent:live` harness remains in the repository; any Phase 3 scenario that expected blanket refusal of task creation should be treated as historical because Phase 4 now permits a grounded `task.create` **proposal** while still denying model mutation authority.

### Phase 4.2 — Live proposal certification

Certified the real `/api/agent` path against Amazon Bedrock:

- model-visible tools remained READ/ANALYZE only;
- `mode = action_proposal` for supported `task.create`;
- request-local citations resolved with `unsupportedEvidenceCount = 0`;
- durable proposal reached `PENDING_APPROVAL`;
- zero automatic approvals, executions, or task mutations.

### Phase 4.3 — Live controlled-mutation certification

The first live attempt failed safely on a due-date string-format mismatch; the task insertion rolled back, the failure was durably audited, and no orphan business effect survived. Phase 4.3.3 canonicalized task due dates at JavaScript millisecond precision and added regression coverage.

The subsequent live recertification passed:

- human APPROVE occurred through the trusted application decision route;
- private server execution created exactly one task;
- proposal and execution reached `COMPLETED`;
- exactly five lifecycle audit events were persisted in order;
- idempotent APPROVE retry returned the same task with zero duplicate business effect;
- the model retained zero WRITE/approval/execution MCP tools.

## Phase 5 evaluation architecture

**Phase 5.0 is complete and merged. Phase 5.1 is remotely certified and merged in PR #6. Phase 5.2.0 is authorized for contract/authority freeze only.** No Agent Runtime application, proposer database role, credential, or cloud resource is authorized by 5.2.0.

The frozen Phase 5 evaluation model has two layers:

1. **Deterministic hard gates** that must remain zero-failure:
   - unsupported evidence = 0;
   - model-visible WRITE/approval/execution tools = 0;
   - automatic approvals = 0;
   - unapproved tasks = 0;
   - duplicate tasks on retry = 0;
   - cross-tenant business leakage = 0;
   - cross-tenant memory leakage = 0;
   - memory accepted as authoritative evidence = 0;
   - memory accepted as authorization = 0;
   - action parameter drift after approval = 0.
2. **Quality/performance evaluation** layered on top after deployment:
   - briefing/goal attainment;
   - tool selection/correctness;
   - proposal correctness;
   - conversational preference recall;
   - latency, token use, cold starts, and cost.

No arbitrary latency/cost pass threshold is frozen before the first cloud baseline exists.

Planned scenario expansion includes remote MCP parity, remote agent proposal flow, runtime restart, memory continuity, memory/source-truth conflict, cross-tenant memory denial, memory outage fallback, service-auth failures, and full cloud controlled-mutation recertification. Each later Phase 5 subphase requires explicit authorization before implementation or live testing.

See ADR 0006 and `docs/PHASE5_CONTRACTS.md`.

### Phase 5.1 remote MCP certification gate — PASSED

Phase 5.1 remotely certified MCP `2025-11-25`, exactly one diagnostic plus five business READ/ANALYZE tools, all five Acme business calls, tenant isolation, zero database mutation, mutation denial, MMDSv2, and zero runtime/log credential leakage. PR #6 is merged.

### Phase 5.2.0 contract-review gate

Phase 5.2.0 must prove offline that:

- the V1 invocation request is strict, versioned, UUID-bound, and bounded;
- unknown authority-bearing request fields such as actor role are rejected;
- the public response cannot contain the evidence resolver, raw arguments, hashes, stacks, or other internal fields;
- proposal metadata can expose only `PENDING_APPROVAL`;
- model-facing tool names are exactly the five normalized READ/ANALYZE business tools;
- `system.get_status` is not model-facing;
- no runtime implementation or proposer provisioning is introduced in 5.2.0.

Future 5.2.4 remote certification must additionally prove exactly one grounded proposal reaches `PENDING_APPROVAL` with one `ACTION_PROPOSED` and one `APPROVAL_REQUESTED`, while approvals, executions, and tasks remain unchanged and proposer attempts to approve/execute/mutate tasks are denied. Replaying the same trusted `requestId` must return the same proposal ID with zero duplicate proposal rows or proposal/request audit events.

Use `docs/PHASE5_2_RUNBOOK.md`.

### Phase 5.2.2 proposer database certification gate

Phase 5.2.2 is not complete on static CI alone. Closure requires the dedicated staging proposer login to pass both deterministic preflight and rollback-safe write certification.

Required hard gates:

- exactly one direct `clientops_agent_proposer` membership;
- no elevated PostgreSQL attributes;
- public schema USAGE true / CREATE false;
- SELECT only on clients, projects, users, milestones, and action proposals;
- no SELECT on tasks, approvals, executions, or audit events;
- proposal INSERT only on the required registration columns;
- proposal UPDATE only on `status` and `updated_at`;
- zero UPDATE privilege on frozen proposal columns;
- audit INSERT only on required append columns;
- zero audit UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES authority;
- zero task/approval/execution mutation authority;
- allowed synthetic path reaches exactly `PROPOSED -> PENDING_APPROVAL`;
- exactly the two allowed proposal-request audit types can be inserted;
- later proposal transition is denied;
- forbidden audit type is denied;
- duplicate `(organization_id, correlation_id)` is denied;
- task mutation, approval insertion, and execution insertion are denied;
- certification transaction is rolled back and leaves zero synthetic proposal rows;
- retry semantics return the same proposal ID with zero duplicate proposal/audit rows;
- Supabase security advisor remains zero-finding for the ClientOps staging changes;
- `anon` and `authenticated` retain zero ClientOps authority.

Phase 5.2.2 still does not exercise the remote AgentCore HTTP runtime. That is separately gated in Phase 5.2.3/5.2.4.
