# Tests

Vitest runs bootstrap invariants from this directory and Phase 1 service tests in services/mcp/src. Those tests cover configuration, real HTTP endpoints, official-client MCP 2025-11-25 initialization/list/call, input/output schemas, transport errors, Host/Origin guards and default loopback binding. The compiled smoke command runs the official client independently and is included in pnpm validate. All use synthetic infrastructure data only, with no cloud or database calls.

See docs/MCP_PROTOCOL.md for the exact test matrix. No business security, model reasoning or browser/E2E suite exists. Playwright remains deferred.
