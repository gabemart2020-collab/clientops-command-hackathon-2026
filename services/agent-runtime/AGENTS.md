# Agent Runtime service scope

Follow root `AGENTS.md`, ADR 0006, `docs/PHASE5_CONTRACTS.md`, and `docs/PHASE5_2_RUNBOOK.md`.

## Current public-release scope (2026-10-21)

- Public Release Gate 2 permits only documentation/fixture sanitization and release readiness changes on `release/public-hardening-20261021`.
- Phase 5.2.3-A (PR #10), B0 (PR #11), and B1 (PR #12) have merged; B2 DynamoDB **architecture only** merged in PR #13. The remote execution path is not thereby certified or deployable.
- B2 implementation, B3–B5 and Gates C–F remain separately gated. No runtime composition/HTTP activation, model authority expansion, AWS/IAM/KMS/DynamoDB/AgentCore operations, deployment, remote invocation, DB changes, or live proposal writes.
- Changing synthetic test identities or policy examples must preserve fail-closed and least-privilege assertions; never substitute actual AWS identifiers into open-source test code.

## Frozen runtime invariants

- HTTP runtime contract: Linux ARM64, Node.js 24, `0.0.0.0:8080`, `GET /ping`, `POST /invocations`.
- Browser-origin requests are rejected.
- Invocation request/response contracts are the strict V1 schemas in `@clientops/contracts`.
- Certification identity must match the exact configured synthetic organization/actor pair.
- Model ID is pinned to `us.anthropic.claude-sonnet-4-6`.
- Agent -> MCP uses the AgentCore data-plane contract and MCP `2025-11-25`.
- Remote MCP catalog must equal the certified six-tool catalog; the model receives only the five READ/ANALYZE business tools.
- `system.get_status` is never model-facing.
- Runtime `main.ts` remains unbound under the historical offline implementation scope. Contracts must not be connected to handler, HTTP ingress, AWS adapter, registrar, or execution paths by this release gate; durable replay ownership is not authorized for implementation.
- The runtime never approves, denies, executes, or mutates tasks.
- Public responses and logs must not contain raw MCP arguments/output, database URLs, secrets, hashes, SQL, stack traces, or hidden reasoning.

For Public Release Gate 2, run only scoped offline tests and CI; a green CI is not publication certification. Do not execute live staging proposer preflight/certification or any cloud/database operation. Preserve the non-deployable boundary.
