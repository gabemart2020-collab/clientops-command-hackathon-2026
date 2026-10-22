# MCP service scope

Follow root AGENTS.md, docs/MCP_PROTOCOL.md, docs/ARCHITECTURE.md, and ADR 0006.

Phase 4 is complete and merged. The MCP service remains the model-facing read/analyze boundary over authoritative business truth.

## Current phase

- Phase 5.0 is complete and merged.
- Phase 5.1 — Non-Production Cloud Data Safety & AgentCore MCP Runtime — is remotely certified and merged in PR #6.
- Phase 5.2.0 is merged in PR #7.
- Phase 5.2.1 — Agent Runtime application — is authorized outside this service.
- The MCP runtime remains a fixed certified dependency; do not modify its catalog or authority for Phase 5.2.1.

## Frozen MCP invariants

- MCP protocol baseline remains `2025-11-25` over Streamable HTTP.
- MCP remains process-stateless for ClientOps correctness.
- Tool catalog remains exactly one READ diagnostic tool plus five READ/ANALYZE business tools.
- Zero WRITE, approval, denial, execution, EXTERNAL, or DESTRUCTIVE tools may be added.
- Human approval and `task.create` execution remain outside MCP.

## Phase 5.1 AgentCore deployment contract

- Phase 5.1 implements a containerized AgentCore MCP runtime while preserving Node.js 24.
- The future cloud container contract is ARM64, host `0.0.0.0`, port `8000`, path `/mcp`.
- Stateless Streamable HTTP remains the preferred MCP mode.
- Local development remains `127.0.0.1:3001/mcp`; cloud listener changes must be configuration-bound and must not weaken local defaults.
- Future service-to-service invocation uses AWS-authenticated transport; no unauthenticated public MCP endpoint is authorized.

## Database boundary

- The MCP runtime is read-only over business truth.
- Local mode remains loopback-only by default.
- Staging mode requires the explicit `local|staging` target policy, `CLIENTOPS_DATABASE_WORKLOAD=mcp`, exact staging host/database allowlist, TLS, and a `clientops_mcp_reader` membership/privilege preflight before the listener starts.
- No generic remote-host bypass is permitted. Remote reset/drop/truncate/destructive seed behavior remains prohibited.

Run `pnpm test:mcp`, `pnpm smoke:mcp`, root `pnpm validate`, and `pnpm build:web` after MCP implementation changes. Phase 5.2.1 consumes this service through the certified AgentCore data-plane boundary; do not add tools or write authority.
