# 0006: AgentCore runtime, memory, identity, and cloud data trust boundaries

Status: Accepted architectural decision for Phase 5.0 contract freeze.
Date: 2026-10-10.
Authority: Explicit user authorization of Phase 5.0 after Phase 4 merge.
Baseline: `main` at `b07b294e232c48145c6a0d3e2c91635580c3b913`.

## Context

Phase 4 proved the complete controlled-action lifecycle locally and against live Amazon Bedrock: grounded model proposal, durable human approval, private trusted `task.create` execution, exact readback, append-only audit, and idempotent retry with zero duplicate business effects.

Phase 5 makes ClientOps Command more deployable, persistent, observable, and measurable without expanding model authority over business state.

Phase 5.0 changes architecture/governance only. It does not provision AWS resources, deploy AgentCore Runtime, create AgentCore Memory, connect to a remote database, install runtime SDKs, or implement production authentication.

## Verified AWS platform capabilities

Verified against AWS documentation on 2026-10-10:

- AgentCore Runtime supports HTTP, MCP, A2A, and AG-UI service contracts. HTTP uses port 8080 and `/invocations`; MCP uses port 8000 and `/mcp`. Authentication options include IAM SigV4 and OAuth 2.0.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
- AgentCore MCP Runtime supports Streamable HTTP and recommends stateless mode for basic MCP servers. MCP containers listen at `0.0.0.0:8000/mcp`; container artifacts are ARM64.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html
- AgentCore direct-code Node.js currently supports Node.js 22. ClientOps remains pinned to Node.js 24, so the planned Runtime deployment uses custom ARM64 containers rather than changing the repository runtime baseline.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-code-deploy-supported-runtimes.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy.html
- AgentCore Memory organizes short-term events by actor/session and long-term records by strategy namespace; custom namespace dimensions can represent organization/tenant context.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html
- AgentCore Memory includes a user-preference strategy that extracts user preferences/styles from USER and ASSISTANT messages.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/user-preference-memory-strategy.html
- IAM SigV4 is the default hosted-runtime authentication mechanism; OAuth/JWT is also supported for inbound identity patterns.
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html

These are AWS platform capabilities, not claims that ClientOps has implemented or deployed them.

## Decision

### 1. Phase 5 preserves Phase 4 authority separation

Phase 5 MUST NOT make the model more powerful over business state.

- PostgreSQL/Supabase remains authoritative business truth.
- Strands/Bedrock remains an untrusted reasoner and proposer.
- MCP remains READ/ANALYZE only.
- Human approval remains outside MCP.
- The private trusted executor remains the only `task.create` business mutation path.
- Model text, AgentCore session state, and AgentCore Memory are never authorization.

### 2. Planned cloud topology

Phase 5 uses separate trust domains:

1. **Next.js trusted application boundary** — human identity/tenant resolution, human review/decision, and private execution boundary.
2. **AgentCore Agent Runtime** — Strands + Bedrock reasoning, MCP consumption, request-local grounding, and proposal registration only.
3. **AgentCore MCP Runtime** — stateless READ/ANALYZE tools over authoritative business data.
4. **PostgreSQL/Supabase** — durable business truth, proposals, approvals, executions, and audit.
5. **AgentCore Memory** — advisory conversational continuity and preferences only.

The browser never invokes AgentCore Runtime directly and never receives AWS credentials or runtime ARNs as authority-bearing values.

### 3. Runtime packaging and protocol freeze

ClientOps keeps Node.js 24.

- Planned Agent Runtime artifact: custom Linux ARM64 container.
- Planned HTTP contract: host `0.0.0.0`, port `8080`, `POST /invocations`, `GET /ping`.
- Planned MCP Runtime artifact: custom Linux ARM64 container.
- Planned MCP contract: host `0.0.0.0`, port `8000`, `POST /mcp`.
- MCP protocol baseline remains `2025-11-25`.
- ClientOps MCP remains stateless for correctness.

Direct-code deployment is not selected for Phase 5 because the currently documented managed Node runtime is Node.js 22 and the repository is pinned to Node.js 24.

### 4. Server-to-server authentication freeze

Machine-to-machine AgentCore invocation uses IAM SigV4 in the initial design.

- Next.js server -> Agent Runtime: SigV4.
- Agent Runtime -> MCP Runtime: SigV4-capable AWS-authenticated invocation.
- Browser -> AgentCore: prohibited.
- Long-lived static bearer tokens for service-to-service invocation: prohibited.

Human authentication is a separate concern. Production OIDC/Cognito identity is planned for a later Phase 5 gate and does not exist in Phase 5.0.

### 5. Agent invocation boundary

The future remote agent invocation must preserve current `/api/agent` public behavior while moving the complete request-local trust unit together:

`agent invocation -> MCP evidence capture -> grounding validation -> proposal registration`

The request-local authoritative evidence registry MUST NOT be serialized to the browser or passed as a generic remote payload.

A remote Agent Runtime may create proposal-control-plane records (`PROPOSED` -> `PENDING_APPROVAL`) but MUST NOT create approvals, executions, or tasks.

### 6. Versioned invocation contract

Future Agent Runtime requests and responses use a versioned contract defined in `docs/PHASE5_CONTRACTS.md`.

Authority-bearing request fields are server-derived. Browser/model input cannot choose organization, actor, role, approval state, execution state, database role, or memory namespace.

### 7. Database role separation

Future non-production cloud access uses separate least-privilege database identities:

- `clientops_mcp_reader`: SELECT-only access required by MCP business tools.
- `clientops_agent_proposer`: SELECT authoritative proposal inputs; create/transition action proposals only through the proposal service; append proposal/request audit events; no approval, execution, or task mutation privileges.
- `clientops_web_approver`: approval-boundary access required to read/lock proposals, validate actors, insert immutable approval, transition proposal, and append approval audit events.
- `clientops_trusted_executor`: execution-boundary access required for locked revalidation, execution records, controlled task insert/readback, proposal terminal transition, and execution audit.

Exact SQL grants are implementation work for a later phase and require separate review.

### 8. Cloud database safety freeze

Current `assertLocalDatabaseTarget` remains unchanged in Phase 5.0.

Future remote staging access MUST NOT use a generic `ALLOW_REMOTE_DB` switch. The design requires:

- explicit target classification (`local` or `staging`);
- exact allowlisted staging hostname, database name, and PostgreSQL username;
- TLS for staging;
- explicit non-production environment guard;
- least-privilege database credential per workload;
- additive migrations only;
- `db:reset`, `demo:reset`, DROP, TRUNCATE, destructive reseeding, and destructive migrations permanently prohibited for remote targets.

Production database access is not authorized by this ADR.

### 9. Memory authority freeze

AgentCore Memory is advisory context only.

Memory MAY influence:

- conversational continuity;
- response presentation;
- operator/user preferences.

Memory MUST NOT establish:

- business facts;
- `EvidenceRef` support;
- project/task/client status;
- proposal parameters or preconditions;
- tenant or actor identity;
- user role;
- approval;
- execution state;
- authorization or policy decisions.

Material operational claims still require current authoritative MCP evidence.

### 10. Initial memory strategy

The initial long-term memory strategy is **user preference only**.

Semantic business-fact memory, episodic operational memory, and memory-based workflow state are outside the initial Phase 5 scope.

Future memory identifiers are server-derived:

- `actorId`: stable opaque internal actor identifier scoped by organization.
- `sessionId`: server-generated UUID per conversation/session.
- namespace: organization + actor + preference strategy scope.

Where AgentCore custom namespace variables are used, values must satisfy AWS namespace constraints.

### 11. Memory payload hygiene

Phase 5 will use an explicit memory adapter rather than relying on uncontrolled automatic persistence of every internal tool event.

Permitted memory inputs are bounded sanitized USER/ASSISTANT conversational content suitable for preference extraction.

Memory persistence MUST exclude:

- raw tool arguments;
- raw tool outputs/evidence registries;
- credentials/tokens;
- database connection strings;
- approval/parameter/binding hashes;
- execution internals;
- raw exceptions/stacks/SQL;
- chain-of-thought or hidden reasoning.

Memory outage must degrade to stateless operation without weakening grounding, policy, or authorization.

### 12. Observability freeze

Future cloud observability must use opaque correlation identifiers and bounded metadata:

`requestId -> sessionId -> agent invocation -> MCP calls -> proposalId -> approvalId -> executionId -> taskId`

Logs/traces MUST NOT contain credentials, raw provider exceptions, raw SQL, chain-of-thought, or unrestricted model/tool payloads.

Any AgentCore/CloudWatch payload logging is enabled only after payload-redaction and retention policy are reviewed using fictional/non-production data.

### 13. Evaluation freeze

Phase 5 evaluation has two layers:

1. deterministic hard gates where failure is binary;
2. AgentCore/LLM quality evaluators layered on top.

Hard gates include zero unsupported evidence, zero model-visible WRITE tools, zero automatic approvals, zero unapproved tasks, zero duplicate tasks, zero cross-tenant business/memory leakage, zero memory-as-evidence acceptance, and preservation of action-parameter binding.

Latency, tokens, cold start, and cost are measured during cloud certification but no arbitrary pass threshold is frozen before a baseline exists.

## Phase gates

Phase 5.0 authorizes only this contract freeze and related documentation/governance updates.

Separate explicit authorization is required before:

- 5.1 non-production cloud database policy implementation and MCP Runtime deployment;
- 5.2 Agent Runtime deployment and remote proposal-path certification;
- 5.3 AgentCore Memory implementation;
- 5.4 production identity-provider implementation;
- 5.5 cloud observability/evaluation certification.

## Implementation status

- Phase 5.0 contract freeze was completed and merged in PR #5.
- Phase 5.1 was separately authorized, remotely certified, and merged in PR #6.
- Phase 5.2.0 was explicitly authorized on 2026-10-12 for the Agent Runtime invocation/proposer contract and authority freeze only.
- Phase 5.2.0 does not authorize Agent Runtime application/deployment, proposer database provisioning, Memory, production identity, or expanded business-action authority.
- Phase 5.2.1+ remains separately gated.

## Consequences

- Positive: cloud adoption cannot silently weaken Phase 4 authority separation.
- Positive: memory can improve continuity without becoming a second source of business truth.
- Positive: database privileges can enforce proposer/approver/executor separation independently of model behavior.
- Negative: deployment requires multiple roles, runtimes, and explicit staging safety configuration.
- Negative: proposal registration moves with the remote agent trust unit, requiring deliberate application/gateway abstraction in a later phase.

Changes to these boundaries require a superseding ADR and explicit user approval.

## Phase 5.2.0 addendum — Agent Runtime/proposer authority freeze

Phase 5.2.0 makes the previously planned Agent Runtime boundary executable without changing the core decision of this ADR.

The Agent Runtime is frozen to the AgentCore HTTP contract: Linux ARM64, Node.js 24, host `0.0.0.0`, port `8080`, `POST /invocations`, and `GET /ping`. Machine ingress remains IAM/SigV4.

The remote request-local trust unit remains:

`MCP evidence capture -> grounding validation -> registerActionProposal`

and moves together into the Agent Runtime. The authoritative evidence resolver cannot be serialized across the runtime boundary.

For Phase 5.2 topology certification, the Bedrock inference profile is frozen to `us.anthropic.claude-sonnet-4-6`. This is a certification dependency, not authorization to expand model tool authority.

The Agent Runtime calls the already-certified MCP Runtime through the AgentCore data plane and exposes exactly five READ/ANALYZE business tools to Strands. `system.get_status` is diagnostic only.

Until production identity is separately authorized, Agent Runtime certification is restricted to one explicitly configured synthetic organization/actor pair. Request identity fields are checked against that server/runtime allowlist and do not convey role, approval, or execution authority.

The planned `clientops_agent_proposer` database workload may create a grounded `task.create` proposal and transition only `PROPOSED -> PENDING_APPROVAL`, with only `ACTION_PROPOSED` and `APPROVAL_REQUESTED` audit events. Database enforcement must independently prevent later proposal transitions, approvals, executions, and task mutation.

The executable invocation schemas and detailed gates are defined in `packages/contracts/src/agent-runtime.ts` and `docs/PHASE5_2_RUNBOOK.md`.
