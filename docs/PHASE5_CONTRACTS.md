# Phase 5 frozen cloud/runtime contracts

Status: Phase 5 contract baseline with Phase 5.1 certified and Phase 5.2.0 Agent Runtime/proposer contract freeze.
Baseline for Phase 5.2.0: `main@280d3222d603d6ca547cc9dcec0c680b3bc017ca`.
Authority: ADR 0006 plus explicit user authorization of Phase 5.2.0 on 2026-10-12.

## 1. Immutable Phase 4 safety invariants

- MCP model tool catalog remains READ/ANALYZE only.
- Human approval resolution remains outside MCP.
- `task.create` is the only authorized business mutation.
- The model cannot approve or execute.
- PostgreSQL remains authoritative business/action/audit state.
- Evidence grounding remains request-local and source-backed.
- Execution revalidates immutable approval binding and current record preconditions.
- Exactly-once effect remains database-enforced.
- EXTERNAL and DESTRUCTIVE actions remain denied.

## 2. Planned deployment modes

| Component | Local mode                              | Future AgentCore mode                                           |
| --------- | --------------------------------------- | --------------------------------------------------------------- |
| MCP       | `127.0.0.1:3001/mcp`                    | ARM64 container, `0.0.0.0:8000/mcp`, Streamable HTTP            |
| Agent     | in-process server-side `ClientOpsAgent` | ARM64 HTTP container, `0.0.0.0:8080`, `/invocations`, `/ping`   |
| Web       | local Next.js                           | trusted application server; deployment target not frozen in 5.0 |
| Database  | local PostgreSQL 16                     | explicit non-production staging PostgreSQL/Supabase target      |
| Memory    | none                                    | AgentCore Memory through explicit adapter                       |

Node.js remains pinned to 24.x. Phase 5 plans container deployment rather than lowering the repository runtime to the current AgentCore direct-code Node.js 22 runtime.

## 3. Agent invocation request V1

Planned internal server-to-server contract:

```ts
type AgentInvocationRequestV1 = {
  version: '1';
  requestId: string; // UUID, server generated
  sessionId: string; // UUID, server generated
  organizationId: string; // UUID, server resolved
  actorId: string; // UUID, server resolved
  userMessage: string; // bounded untrusted user input
  accountHint?: string; // bounded untrusted hint
};
```

Rules:

- `organizationId`, `actorId`, `requestId`, and `sessionId` are never accepted from raw browser/model claims as trusted values.
- Browser identity must first resolve to trusted application context; until Phase 5.4, only explicitly non-production certification identity is allowed.
- Runtime rejects unknown fields and unsupported `version` values.
- Request values are never authorization for approval or execution.

## 4. Agent invocation response V1

Planned internal response:

```ts
type AgentInvocationResponseV1 =
  | {
      version: '1';
      requestId: string;
      success: true;
      data: {
        brief: AgentBrief;
        toolTrace: PublicToolTrace[];
        modelId: string;
        stopReason: string;
        latencyMs: number;
        tokenUsage?: TokenUsage;
        grounding: {
          valid: boolean;
          unsupportedEvidenceCount: number;
        };
        actionProposal?: {
          proposalId: string;
          status: 'PENDING_APPROVAL';
          reviewUrl: string;
        };
      };
    }
  | {
      version: '1';
      requestId: string;
      success: false;
      code: string;
      error: string; // bounded public-safe message
    };
```

Never include:

- `evidenceResolver`;
- full authoritative evidence registry;
- raw MCP arguments or raw tool error text;
- parameter or approval-binding hashes;
- credentials/tokens;
- database URLs;
- raw provider errors/stacks/SQL;
- chain-of-thought.

## 5. Proposal registration locality

The proposal registration trust unit remains:

`MCP evidence capture -> request-local resolver -> grounding -> registerActionProposal`

In future AgentCore mode this unit executes inside the Agent Runtime application boundary. Only the sanitized registered proposal metadata returns to Next.js.

Agent Runtime proposal privileges stop at `PENDING_APPROVAL`.

Agent Runtime MUST NOT:

- insert approval rows;
- create execution rows;
- create/update tasks;
- transition proposals to `APPROVED`, `DENIED`, `EXECUTING`, `COMPLETED`, or `FAILED`;
- call approval or execution endpoints.

## 6. Database target contract

Configuration semantics frozen in Phase 5.0 and implemented for the Phase 5.1 MCP workload:

```text
CLIENTOPS_DATABASE_TARGET=local|staging
CLIENTOPS_DATABASE_WORKLOAD=mcp   # required only for Phase 5.1 staging access
```

`local`:

- existing loopback/container allowlist;
- current local/test database-name safety checks;
- local reset/seed utilities allowed under existing guards.

`staging`:

- exact configured hostname;
- exact configured database name;
- exact configured PostgreSQL username;
- TLS required;
- explicit staging environment guard;
- workload-specific least-privilege credential;
- reset/drop/truncate/destructive seed prohibited;
- additive migrations only through a separately reviewed staging migration command.

There is deliberately no `ALLOW_REMOTE_DB=true` escape hatch.

## 7. Database workload roles

| Role             | Intended permissions                                                                        | Explicitly denied                                     |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| MCP reader       | SELECT business tables needed by READ/ANALYZE tools                                         | proposal/approval/execution/task mutation             |
| Agent proposer   | read proposal inputs; create/advance proposal to `PENDING_APPROVAL`; proposal/request audit | approval, execution, task mutation                    |
| Web approver     | trusted actor validation; immutable approval; proposal approval/denial; approval audit      | task insert outside executor                          |
| Trusted executor | approved execution lifecycle and exactly one controlled task insert                         | arbitrary action types / external destructive effects |

Exact SQL grants are not Phase 5.0 implementation.

## 8. Memory contract

### Allowed

- short-term conversational continuity;
- long-term operator/user preferences;
- response style/presentation preferences.

### Forbidden as authority

- business facts;
- evidence citations;
- tenant membership;
- actor role;
- approval state;
- action parameters/preconditions;
- execution state;
- policy decisions.

### Identity

```ts
type MemoryIdentity = {
  organizationId: string; // trusted server context
  actorId: string; // trusted server context
  sessionId: string; // server-generated UUID
};
```

Planned long-term namespace is organization + actor scoped and preference-specific. Exact AgentCore resource/strategy IDs are runtime configuration, never browser/model input.

### Stored payload hygiene

Persist only bounded sanitized USER/ASSISTANT content intended for conversational continuity or preference extraction.

Never persist raw tool output, authoritative evidence registries, secrets, hashes, SQL, stack traces, or hidden reasoning.

### Retrieval

Retrieved memories are labeled advisory and injected separately from authoritative tool evidence. Grounding code must never register memory as an `EvidenceRef`.

### Failure

Memory unavailable -> continue statelessly if the core agent/MCP path is healthy. Do not weaken any grounding, approval, or execution checks.

## 9. Service authentication contract

- Web server -> Agent Runtime: IAM SigV4.
- Agent Runtime -> MCP Runtime: AWS-authenticated service-to-service invocation (initial design: IAM SigV4).
- Browser -> AgentCore Runtime: prohibited.
- Human browser authentication: later OIDC Phase 5 gate.
- Static long-lived service bearer tokens: prohibited.

## 10. Observability contract

Allowed correlation lineage:

`requestId -> sessionId -> agent invocation -> MCP call summaries -> proposalId -> approvalId -> executionId -> taskId`

Allowed telemetry includes bounded timing, token counts, tool names/status/duration/evidence counts, result status, and opaque IDs.

Prohibited telemetry includes raw prompts by default, raw tool payloads, chain-of-thought, credentials, DB connection strings, approval hashes, raw SQL, and raw exceptions.

## 11. Phase 5 hard gates

| Gate                                         | Required |
| -------------------------------------------- | -------- |
| Unsupported evidence                         | 0        |
| Model-visible WRITE/approval/execution tools | 0        |
| Automatic human approvals                    | 0        |
| Unapproved tasks                             | 0        |
| Duplicate tasks on idempotent retry          | 0        |
| Cross-tenant business leakage                | 0        |
| Cross-tenant memory leakage                  | 0        |
| Memory accepted as authoritative evidence    | 0        |
| Memory accepted as authorization             | 0        |
| Action parameter drift after approval        | 0        |

Performance/cost metrics are measured after deployment but do not receive invented pass thresholds in Phase 5.0.

## 12. Phase sequencing

- **5.0 (completed / merged):** contract/governance freeze.
- **5.1 (completed / remotely certified / merged):** explicit staging DB safety + AgentCore MCP Runtime.
- **5.2.0–5.2.2 (completed/merged):** Agent Runtime/proposer contracts, local Agent Runtime application, and database authority boundary.
- **5.2.3-A/B0/B1 (completed/merged):** offline trusted-caller gate, trusted runtime architecture, and signed invocation contract.
- **5.2.3-B2:** DynamoDB architecture choice recorded; implementation, B3–B5, live AWS deployment and remote proposal certification remain gated.
- **5.3 (gated):** AgentCore Memory preference continuity.
- **5.4 (gated):** production human OIDC identity boundary.
- **5.5 (gated):** observability, evaluations, and full cloud certification.

Historical phase authorizations do not grant new deployment or database powers. As of 2026-10-21, Public Release Gate 2 authorizes only bounded repository release corrections; it does not authorize AWS/database operations.

## 13. Phase 5.1 certification status

Phase 5.1 is complete, remotely certified, and merged in PR #6.

Certified properties include:

- isolated Supabase staging target with exact host/database/user/TLS guards;
- `clientops_mcp_reader` least-privilege workload identity;
- zero ClientOps privileges for `anon` / `authenticated`;
- zero Supabase security-advisor findings;
- AgentCore MCP Runtime (exact ID retained only in private certification evidence) version 2, READY at the recorded certification;
- `metadataConfiguration.requireMMDSV2 = true`;
- immutable image digest verified at certification (exact value withheld from public docs);
- MCP protocol `2025-11-25`;
- exactly one diagnostic tool plus five business READ/ANALYZE tools;
- zero write/approval/execution tools;
- unchanged task/proposal/approval/execution/audit counts during certification;
- tenant isolation and mutation denial;
- no runtime/log secret leakage.

## 14. Phase 5.2.0 Agent Runtime/proposer freeze

The executable V1 schemas are authoritative in `packages/contracts/src/agent-runtime.ts`.

The Agent Runtime contract is:

- protocol `HTTP`;
- Linux ARM64;
- Node.js 24;
- `0.0.0.0:8080`;
- `GET /ping`;
- `POST /invocations`;
- IAM/SigV4 machine ingress;
- no browser-direct invocation;
- model certification profile `us.anthropic.claude-sonnet-4-6`;
- Agent -> MCP through the AgentCore data plane;
- exact MCP baseline `2025-11-25`;
- exactly five model-facing READ/ANALYZE tools.

The V1 request is strict. `requestId`, `sessionId`, `organizationId`, and `actorId` are trusted caller/server context; untrusted browser/model input cannot supply role, approval, execution, database, model, or memory authority.

`requestId` is the durable proposal-registration idempotency key and maps to the proposal correlation identifier. Phase 5.2.2 must enforce/reconcile uniqueness for `(organizationId, requestId)` so retries return the same proposal rather than creating duplicate approval requests.

Until production identity is separately authorized, remote certification is restricted to one configured synthetic organization/actor pair and mismatches fail closed.

The Agent Runtime proposal authority stops at:

`PROPOSED -> PENDING_APPROVAL`

with only `ACTION_PROPOSED` and `APPROVAL_REQUESTED` audit insertion.

The future `clientops_agent_proposer` workload must be database-enforced so it cannot approve, deny, execute, mutate tasks, or transition a proposal beyond `PENDING_APPROVAL`.

See `docs/PHASE5_2_RUNBOOK.md`.

## Phase 5.2.2 proposer database authority

Phase 5.2.1 is certified and merged in PR #8. Phase 5.2.2 is authorized to implement and certify the dedicated staging proposal-registration workload.

The durable request identity is `(organization_id, correlation_id)`, where `correlation_id` is the trusted Agent Runtime `requestId`. A unique constraint is mandatory and deployment must fail if pre-existing duplicates are found.

The application proposal service must reconcile a concurrent unique-key race by returning the winning proposal after transaction rollback. A replay must not generate another proposal or another `ACTION_PROPOSED` / `APPROVAL_REQUESTED` pair.

The staging database proposer is a separate role from the MCP reader. Its authority is exactly:

- SELECT clients/projects/users/milestones/action_proposals;
- INSERT the required proposal columns at `PROPOSED`;
- UPDATE only proposal `status` / `updated_at`, with database enforcement restricting the transition to `PROPOSED -> PENDING_APPROVAL`;
- INSERT only proposal-request audit rows whose event type/correlation/binding are database-validated.

It receives no task, approval, or execution mutation authority and no audit-table read authority.

The Agent Runtime PostgreSQL registrar may be implemented and staging-certified in 5.2.2, but the runtime process remains unbound from cloud secret hydration and AgentCore deployment until 5.2.3.
