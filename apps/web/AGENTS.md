# Web scope

Follow root AGENTS.md, docs/ARCHITECTURE.md, docs/SECURITY.md, docs/TOOL_CONTRACTS.md, ADR 0005, and ADR 0006.

Phase 4 is complete and merged. The web application remains the trusted human application boundary for proposal review, APPROVE/DENY, and private controlled `task.create` execution.

## Current phase

- Phase 5.0 is complete and merged.
- Phase 5.1 — Non-Production Cloud Data Safety & AgentCore MCP Runtime — is authorized.
- Phase 5.1 does not change the web application runtime path: `POST /api/agent` continues using the existing local/in-process server-side agent until Phase 5.2 is separately authorized.
- Do not add AgentCore Agent Runtime invocation, production identity, Memory, new action types, or public deployment/auth claims.

## Existing trusted boundaries

- `POST /api/agent` currently invokes the local server-side ClientOps agent and may register a grounded `task.create` proposal.
- `GET /api/actions/[proposalId]` returns a tenant-scoped sanitized review view.
- `POST /api/actions/[proposalId]/decision` records server-resolved APPROVE/DENY and may invoke the private executor after APPROVE.
- The browser never receives AWS credentials, privileged DB credentials, evidence resolvers, approval hashes, or raw execution internals.

## Phase 5 frozen web boundary

- Future AgentCore invocation is server-to-server only; the browser must not call AgentCore Runtime directly.
- The future web-to-agent request envelope carries only server-derived tenant/actor/session identifiers plus bounded user input.
- Future remote agent responses preserve current public `/api/agent` semantics and remain sanitized.
- Human approval and the trusted executor remain outside the model/MCP boundary.
- Production OIDC identity is a later Phase 5 implementation gate, not a Phase 5.0 claim.
- The local demo actor remains dev/test-only until production identity is explicitly implemented and certified.

## Security

- Same-origin/CSRF protection, tenant checks, bounded inputs, and public error masking remain mandatory.
- EXTERNAL/DESTRUCTIVE actions and new WRITE action types remain prohibited.
- AgentCore Memory is advisory and cannot establish human identity, tenant, role, approval, or business facts.

## Validation

For repository changes run root `pnpm validate` and `pnpm build:web`. Phase 5.1 live testing is limited to the read-only AgentCore MCP Runtime and isolated synthetic staging database.
