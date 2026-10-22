# Agent package scope

Follow root AGENTS.md, docs/ARCHITECTURE.md, docs/TOOL_CONTRACTS.md, docs/SECURITY.md, ADR 0005, and ADR 0006.

Phase 3 established Strands + Bedrock agentic orchestration. Phase 4 added grounded `task.create` proposal output while keeping model authority READ/ANALYZE only. Phase 5.0 froze the cloud/runtime contracts. Phase 5.1 remotely certified the MCP/data plane. Phase 5.2.0 now freezes only the Agent Runtime/proposer contracts.

## Current phase

- Phase 4 is complete, merged, and live certified.
- Phase 5.0 is complete and merged.
- Phase 5.1 — Non-Production Cloud Data Safety & AgentCore MCP Runtime — is remotely certified and merged in PR #6.
- Phase 5.2.0 — Agent Runtime & Remote Proposal Path Contract/Authority Freeze — is complete and merged in PR #7.
- Phase 5.2.1 — Agent Runtime application — is authorized.
- The existing `ClientOpsAgent` may be reused behind the new local/offline Agent Runtime and injected AgentCore MCP tool adapter.
- No Agent Runtime AWS deployment, proposer database provisioning, AgentCore Memory, production identity, new action type, or model WRITE capability may be added in Phase 5.2.1.

## Model authority

- Authorized model-facing tools remain exactly the five ClientOps READ/ANALYZE business tools.
- The model may emit a bounded grounded `action_proposal` for `task.create`.
- The model never receives WRITE, approval, denial, or execution tools.
- `task.create` remains a private trusted-server effect after durable human approval.
- AgentCore Runtime or Memory must not become an authorization source.

## Phase 5 frozen agent boundary

- The frozen Phase 5.2 remote agent execution contract preserves the existing `ClientOpsAgent` behavioral contract and MCP 2025-11-25 baseline.
- Request-local evidence collection, grounding validation, and proposal registration stay within the same trusted agent-application invocation boundary so authoritative evidence registries are never serialized to browsers.
- Public/runtime responses must remain sanitized and must not expose evidence resolvers, raw tool inputs/errors, approval hashes, credentials, stacks, or internal registries.
- Future memory retrieval may influence presentation and conversational continuity only. It cannot satisfy evidence citations, proposal preconditions, actor/tenant identity, human approval, or execution state.
- Initial long-term memory design is user/operator preferences only; semantic business-fact memory is outside the Phase 5.0 frozen scope.

## Runtime/session principles

- Runtime sessions are convenience/continuity, never authoritative state.
- Correctness must survive runtime restart or scale-out.
- Tenant, actor, and session identifiers are server-derived.
- Memory failure must fail open only to a stateless conversational experience, never to weaker authorization or grounding.

## Validation

Phase 5.2.1 may implement and test the Agent Runtime application locally/offline. Do not deploy it, provision the proposer database identity, create Memory, add production identity, or change controlled task mutation authority in this subphase. Repository static/test/build gates remain mandatory.
