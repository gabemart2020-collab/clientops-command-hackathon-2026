# Phase 5.2 — Agent Runtime & Remote Proposal Path Runbook

Status (2026-10-21): Historical Phase 5.2 runbook. Phase 5.2.0/5.2.1/5.2.2 and offline Gate A are complete; B0/B1 contracts and B2 DynamoDB architecture are merged (PRs #11–#13). This document does not authorize implementing B2–B5, remote deployment/certification, database writes, or changing AWS resources. Release Gates 2 and 3 were subsequently merged. This remains a historical operational runbook and does not authorize cloud activity.

Baseline: `main@b87bca6bca549d06e6aeb907fedb533c0db2d22e`.

Authority: Explicit user authorization of Phase 5.2.0, Phase 5.2.1, and Phase 5.2.2 on 2026-10-12.

## 1. Objective

Phase 5.2 moves the existing request-local agent trust unit into Amazon Bedrock AgentCore Runtime while preserving the Phase 4 authority model:

`agent invocation -> MCP evidence capture -> grounding validation -> proposal registration`

The remote Agent Runtime may reason, read authoritative business evidence, validate grounding, and register a grounded `task.create` proposal through `PENDING_APPROVAL`.

It MUST NOT approve, deny, execute, create/update tasks, perform external actions, or perform destructive actions.

Phase 5.2 does not add AgentCore Memory or production human identity.

## 2. Fixed Phase 5.1 dependency

Phase 5.2 treats the certified Phase 5.1 MCP Runtime as a fixed read/analyze dependency.

Certified dependency at the 5.2.0 freeze (sanitized record; retrieve exact resource IDs only from approved private evidence before any separately authorized AWS operation):

- AWS account: `<approved-nonproduction-account-id>` (actual account identity withheld from public docs)
- region: `us-east-1`
- MCP Runtime ID: `<privately-recorded-certified-runtime-id>`
- MCP Runtime ARN: `<privately-recorded-certified-runtime-arn>`
- Runtime version: `2`
- status: `READY`
- platform: `V2`
- MMDSv2: required
- MCP protocol: `2025-11-25`
- certified image digest: `<privately-recorded-certified-image-digest>`

Phase 5.2 MUST NOT expand the MCP catalog. Model-facing tools remain exactly:

1. `account.get_context`
2. `activity.get_recent`
3. `commitment.list_open`
4. `project.assess_delivery_health`
5. `meeting.prepare_brief`

`system.get_status` remains a diagnostic/runtime certification tool and is not model-facing.

## 3. Agent Runtime protocol freeze

The Agent Runtime uses AgentCore HTTP protocol with:

- architecture: `linux/arm64`
- Node.js major: `24`
- host: `0.0.0.0`
- port: `8080`
- health endpoint: `GET /ping`
- invocation endpoint: `POST /invocations`
- JSON request/response for Phase 5.2 certification
- inbound machine authentication: IAM/SigV4
- MMDSv2: required
- browser-direct invocation: prohibited

`GET /ping` returns a bounded AgentCore-compatible body with `status: "Healthy"` when the process is ready for new work.

Phase 5.2 does not require SSE, WebSocket, AG-UI, A2A, OAuth, or browser-accessible AgentCore endpoints.

The live AWS HTTP protocol contract was re-verified on 2026-10-12 against the AgentCore documentation. HTTP containers use `0.0.0.0:8080`, `POST /invocations`, and `GET /ping`.

## 4. Agent invocation V1 contract

Executable schemas live in:

`packages/contracts/src/agent-runtime.ts`

The request is strict and versioned:

```ts
type AgentInvocationRequestV1 = {
  version: '1';
  requestId: string; // UUID, trusted caller/server generated
  sessionId: string; // UUID, trusted caller/server generated
  organizationId: string; // UUID, trusted application context
  actorId: string; // UUID, trusted application context
  userMessage: string; // bounded untrusted content
  accountHint?: string; // bounded untrusted hint
};
```

Unknown fields are rejected.

The request does not accept actor role, approval state, execution state, database identity, memory namespace, AWS identity, model ID, proposal status, or action authority.

### Trusted invocation envelope and idempotency ownership — Phase 5.2.3 deployment gate

The `requestId`, `sessionId`, `organizationId`, and `actorId` fields are trusted **only after** the server-side invoking principal has been authenticated and authorized. UUID syntax and matching the configured certification identity are necessary checks but **do not** prove the origin or ownership of a request ID. Model output, user messages, browser payloads, and arbitrary external HTTP callers must not choose or override these fields.

Before the remote Agent Runtime is enabled in Phase 5.2.3, the trusted IAM/SigV4 invocation path must establish an allowlisted caller, bind the certification organization/actor to that caller, and generate or securely own the stable request ID. Retries may reuse an ID only for the same authorized logical invocation; an untrusted caller must not be able to replay another caller's ID. If this cannot be demonstrated with negative tests, remote invocation remains disabled. This is a deployment prerequisite, **not** a claim that Phase 5.2.2 already authenticates the incoming invocation body.

Proposal idempotency is first-write-wins for `(organization_id, correlation_id)`: a repeat with the same trusted request ID returns the existing proposal without replacing its parameters, even if the replayed model output differs. That is not authorization to overwrite or select another request's proposal. A conflicting payload for an already-owned request ID must not create a second proposal or mutate the first. This contract is covered by the existing proposal-service replay test and must remain unchanged during this tests-and-governance hardening pass.

`requestId` is also the durable proposal-registration idempotency key for the invocation. The runtime must pass it to proposal registration as the authoritative correlation identifier; callers must not receive a new proposal merely because the same trusted request is retried.

The successful response is also strict and may contain only:

- `brief`
- sanitized public tool trace
- model ID
- stop reason
- latency
- bounded token usage
- grounding summary
- optional proposal metadata

Proposal metadata status is literally `PENDING_APPROVAL`.

The response MUST NOT contain:

- the authoritative evidence resolver/registry;
- raw MCP arguments;
- raw MCP output;
- raw provider errors;
- database URLs;
- credentials/tokens;
- parameter hashes;
- approval binding hashes;
- approval records;
- execution records;
- task mutation internals;
- SQL;
- stack traces;
- chain-of-thought or hidden reasoning.

## 5. Non-production certification identity

Production OIDC/Cognito identity is not part of Phase 5.2.

Until the later production-identity gate, the deployed Agent Runtime may accept only one explicit synthetic certification identity configured by trusted server/runtime configuration:

- `CLIENTOPS_CERTIFICATION_ORGANIZATION_ID`
- `CLIENTOPS_CERTIFICATION_ACTOR_ID`

For every invocation, the runtime must compare request `organizationId` and `actorId` against that configured pair and reject any mismatch with the bounded public code `CERTIFICATION_IDENTITY_MISMATCH`.

The request cannot supply actor role or authorization claims.

The certification identity is not approval authority. It only scopes the non-production agent invocation.

## 6. Model freeze for topology certification

Phase 5.2 certification uses the active US inference profile:

`us.anthropic.claude-sonnet-4-6`

The purpose is to certify the remote topology and proposal path without simultaneously changing model behavior during the deployment-boundary migration.

The runtime configuration must set explicit output/turn/token limits. It must not rely on an unbounded provider default.

A later model migration requires separate review if it materially changes agent behavior or tool-use semantics.

## 7. Agent -> MCP boundary

The remote Agent Runtime MUST call the certified MCP Runtime through the AWS AgentCore data plane using IAM/SigV4.

Do not bypass AgentCore with an unauthenticated direct container URL.

The Phase 5.2 MCP adapter must:

- invoke the exact certified MCP Runtime ARN;
- negotiate MCP `2025-11-25`;
- discover the remote tool catalog;
- fail closed if the catalog does not contain the expected certified tools;
- expose only the five business READ/ANALYZE tools to Strands;
- keep `system.get_status` outside the model tool list;
- normalize dot names only at the Strands/model boundary;
- never expose WRITE/approval/execution tools if a future MCP version accidentally adds them;
- sanitize remote MCP errors before they reach logs or public responses.

Application correctness must not depend on AgentCore runtime session state. A runtime restart or scale-out must not change business truth or authorization.

## 8. Proposal registration locality

Proposal registration moves from the current Next.js `/api/agent` process into the Agent Runtime together with the request-local grounding registry.

The authoritative evidence resolver MUST remain inside that same invocation boundary until `registerActionProposal()` completes.

Only the sanitized registered proposal metadata may leave the Agent Runtime:

```text
proposalId
status = PENDING_APPROVAL
reviewUrl
```

The Agent Runtime MUST NOT return the evidence resolver or serialize it back to Next.js.

## 9. Dedicated proposer database identity

Phase 5.2.2 provisions a dedicated staging workload identity separate from the Phase 5.1 MCP reader.

Authorized group role:

`clientops_agent_proposer`

Authorized LOGIN role:

`clientops_agent_staging_login`

The LOGIN role must be a member only of `clientops_agent_proposer` and have no elevated PostgreSQL attributes.

Required proposal-registration reads are limited to authoritative records needed by `registerActionProposal()`, currently:

- clients
- projects
- users
- milestones
- proposal rows required to complete/verify the allowed transition

The proposer may create a `task.create` action proposal at `PROPOSED`, append only the two proposal-request audit event types, and transition only:

`PROPOSED -> PENDING_APPROVAL`

The proposer MUST have zero authority to:

- insert/update/delete tasks;
- insert approvals;
- insert executions;
- transition a proposal to `APPROVED`, `DENIED`, `EXECUTING`, `COMPLETED`, `FAILED`, or any later lifecycle status;
- update proposal parameters/evidence/hashes after insertion;
- update/delete audit events;
- create schema/database objects;
- reset, truncate, drop, or destructively reseed staging.

## 10. Database-enforced proposer authority

Application policy alone is insufficient.

Phase 5.2.2 MUST add database enforcement that recognizes the proposer workload role and fails closed.

At minimum:

### action_proposals

For proposer-role writes:

- INSERT requires `action_type = task.create`;
- INSERT requires `action_class = WRITE`;
- INSERT requires initial `status = PROPOSED`;
- UPDATE permits only `PROPOSED -> PENDING_APPROVAL`;
- UPDATE permits only the lifecycle fields necessary for that transition;
- proposal parameters, evidence, hashes, preconditions, tenant, action type/class, justification, correlation ID, creation time, and expiration remain immutable.

### audit_events

For proposer-role INSERT:

- event type must be exactly `ACTION_PROPOSED` or `APPROVAL_REQUESTED`;
- UPDATE and DELETE remain prohibited.

### protected business/control tables

The proposer receives no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privileges on:

- tasks
- action_approvals
- action_executions

The certification must prove these denials with harmless no-op-shaped statements inside rolled-back transactions.

### proposal request idempotency

Phase 5.2.2 MUST add a durable database uniqueness/reconciliation mechanism for the trusted invocation request identity.

The required logical key is:

`(organizationId, requestId)`

where `requestId` is persisted as the proposal registration correlation identifier.

Before adding the constraint/index or equivalent idempotency record, 5.2.2 must audit staging for pre-existing duplicate correlation identifiers and fail closed rather than silently deleting or merging records.

A replay of the same trusted request must return the existing proposal and MUST NOT append another `ACTION_PROPOSED` or `APPROVAL_REQUESTED` event.

## 11. Agent Runtime secrets and IAM

A later, separately authorized deployment gate may create a dedicated Agent Runtime execution role. It must not reuse the MCP Runtime execution role. B0 creates no roles or AWS resources.

The Agent Runtime execution role is expected to need only:

- pull from its exact private ECR repository;
- invoke the explicitly selected Bedrock inference profile/model resources;
- invoke the exact certified Phase 5.1 MCP Runtime;
- read exactly one proposer database secret from Secrets Manager;
- emit bounded AgentCore logs/traces/metrics.

It MUST NOT receive approval/execution IAM permissions or unrelated AWS administration permissions.

Explicitly deny or omit `bedrock-agentcore:InvokeAgentRuntimeForUser` unless a later identity design authorizes user delegation.

Database credentials MUST come from Secrets Manager. Do not set plaintext `DATABASE_URL` in AgentCore runtime environment variables.

AgentCore environment variables may contain only non-secret configuration and resource identifiers.

## 12. Phase 5.2 gates

### 5.2.0 — Contract and authority freeze

Authorized scope:

- executable V1 request/response schemas;
- certification identity contract;
- Agent Runtime HTTP/container contract;
- model/tool catalog freeze;
- proposer authority design;
- Agent -> MCP authentication design;
- runbook/governance/evaluation updates;
- regression tests.

Explicitly not authorized by 5.2.0:

- creating Agent Runtime AWS resources;
- creating ECR repository/image for the Agent Runtime;
- creating proposer PostgreSQL roles/triggers;
- creating proposer Secrets Manager values;
- modifying the certified MCP Runtime;
- creating AgentCore Memory;
- implementing production identity.

### 5.2.1 — Agent Runtime application

Authorized after Phase 5.2.0 merge.

Implemented scope:

- `services/agent-runtime` workspace;
- AgentCore-compatible `GET /ping` and `POST /invocations` HTTP boundary;
- strict V1 request/response validation and browser-Origin rejection;
- exact synthetic certification identity enforcement before tool/model work;
- AgentCore MCP JSON-RPC/SSE adapter behind an injected data-plane invoker;
- exact six-tool remote catalog assertion with only five normalized READ/ANALYZE tools exposed to Strands;
- existing `ClientOpsAgent` reuse with frozen Sonnet 4.6 model/limit configuration;
- request-local evidence and grounding retained through an injected proposal-registration seam;
- proposal persistence unavailable by default until 5.2.2;
- bounded public errors/log metadata only;
- request body size limit and graceful SIGTERM/SIGINT shutdown;
- local/offline tests.

  5.2.1 intentionally leaves the concrete AWS AgentCore data-plane client binding to 5.2.3 and the real proposer database registrar to 5.2.2. No cloud deployment occurs in 5.2.1.

### 5.2.2 — Proposer database boundary — COMPLETE

Implemented/review scope:

- durable `(organization_id, correlation_id)` uniqueness with fail-closed duplicate audit before constraint creation;
- request replay lookup and PostgreSQL unique-race reconciliation in `registerActionProposal()`;
- staging-only group `clientops_agent_proposer` and login `clientops_agent_staging_login`;
- exact SELECT grants on clients/projects/users/milestones/action_proposals;
- column-scoped proposal INSERT and only `status` / `updated_at` UPDATE authority;
- column-scoped audit INSERT with no audit SELECT;
- database-enforced proposer INSERT/lifecycle restrictions;
- database-enforced audit event type/correlation/hash restrictions;
- zero task/approval/execution mutation authority;
- explicit `agent-proposer` staging workload policy;
- deterministic proposer privilege preflight;
- real PostgreSQL `ProposalRegistrar` factory reusing the existing grounded proposal service;
- rollback-safe live staging certification script;
- dedicated proposer database credential/Secrets Manager value;
- real staging privilege/security certification.

Phase 5.2.2 must not bind/deploy the concrete AgentCore AWS data-plane runtime. The runtime entry point remains fail-closed/unbound until Phase 5.2.3.

### 5.2.3 — Trusted runtime integration gates — separately gated

Planned scope:

- exact-head ARM64 image;
- private immutable ECR repository/tag/digest;
- image scan;
- dedicated least-privilege execution role;
- digest-pinned AgentCore HTTP Runtime;
- IAM/SigV4 ingress;
- MMDSv2;
- non-secret environment only;
- log/telemetry boundary verification.

### 5.2.4 — Remote proposal-path certification — separately gated

Planned certification:

`trusted certification caller -> Agent Runtime -> MCP Runtime -> staging business reads -> grounding -> proposal registration`

Required deterministic results:

- Agent Runtime READY;
- MMDSv2 true;
- `/ping` healthy;
- V1 invocation accepted;
- remote model-visible tools exactly five READ/ANALYZE tools;
- remote MCP protocol `2025-11-25`;
- Acme evidence grounded with unsupported evidence count = 0;
- exactly one new proposal for the certification action;
- proposal ends at exactly `PENDING_APPROVAL`;
- exactly one `ACTION_PROPOSED` event;
- exactly one `APPROVAL_REQUESTED` event;
- approvals added = 0;
- executions added = 0;
- tasks added = 0;
- proposer approval attempt denied;
- proposer execution insert denied;
- proposer task mutation denied;
- cross-tenant request denied;
- retry of the same trusted `requestId` returns the same proposal ID;
- retry adds zero duplicate proposal rows and zero duplicate proposal/request audit events;
- runtime restart/retry preserves correctness and does not create an unauthorized business effect;
- public/runtime/log surfaces contain no database credential, raw provider exception, SQL, internal evidence registry, hashes, or chain-of-thought.

## 13. Stop boundary

Phase 5.2 completion does not authorize:

- AgentCore Memory;
- production OIDC/Cognito identity;
- additional action types;
- model-facing WRITE tools;
- automatic approval;
- automatic execution;
- production database access;
- external/destructive business actions.

Those remain separately gated.

## 14. Phase 5.2.3-B0 architecture status

`docs/PHASE5_2_3_B_ARCHITECTURE.md` and accepted ADR 0007 document the trusted invocation boundary. B1 signed-envelope implementation merged in PR #12; the DynamoDB ownership **architecture choice** was recorded in PR #13, not a working cloud store. B2 implementation, B3–B5, and Gates C–F require separate authorization. This historical architecture description is not deployment authority. Preserve the frozen MCP reader/proposer privileges, five model-facing READ/ANALYZE tools, and Phase 4 human approval boundary.
