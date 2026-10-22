# MCP protocol proof

## Competition baseline and implementation

**Verified requirement:** the selected Alexa+ MCP route requires 2025-11-25 or later over Streamable HTTP; see [competition requirements](HACKATHON_REQUIREMENTS.md). **Architectural decision:** our acceptance baseline remains exactly **2025-11-25**.

**Implemented locally / verified, 2026-09-28:** services/mcp uses stable official @modelcontextprotocol/server 2.1.0, @modelcontextprotocol/node 2.1.0 and Zod 4.6.5. The official @modelcontextprotocol/client 2.1.0 is a development dependency for tests and smoke. Registry engines are Node >=20; this project exclusively runs Node 24.x. Package metadata and the current [official SDK repository](https://github.com/modelcontextprotocol/typescript-sdk) were inspected before installation; v2 is the stable line, not a prerelease or obsolete SDK chosen for the old baseline.

**SDK capabilities:** v2 also implements the newer 2026-07-28 protocol. createMcpHandler serves a 2025 compatibility path with legacy: stateless. Each HTTP exchange gets a fresh McpServer; no session ID, store or persistent application state is created. A 2025 initialized notification is acknowledged without retaining connection state. This compatibility path is still Streamable HTTP, not the old HTTP+SSE transport. See the SDK's [HTTP serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html) and [2025 compatibility guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html), checked 2026-09-28.

**Tested compatibility:** automated proof pins the official client supportedProtocolVersions to [2025-11-25] and versionNegotiation.mode to legacy. It connects over an actual ephemeral TCP listener, records the outgoing initialize protocolVersion and incoming InitializeResult, asserts transport.protocolVersion is exactly 2025-11-25 and client.getProtocolEra() is legacy, then verifies the initialized notification and subsequent version headers. No server/discover call or newer envelope is used for acceptance.

**Future compatibility:** the SDK naturally exposes newer behavior, but the 2026 path is not the Phase 1 acceptance target and is not certified here. Subscriptions are disabled for this proof (maxSubscriptions: 0). Do not infer later-version acceptance or product compatibility from installed SDK capabilities.

## Endpoints and tool

Native node:http routes through SDK toNodeHandler; there is no Express application or legacy SSE endpoint.

| Endpoint     | Implemented behavior                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /mcp    | SDK initialization, notifications and MCP requests; the 2025 path returns SSE-framed JSON-RPC results, and accepted notifications return 202 |
| GET /mcp     | SDK 405 for the stateless 2025 path; no standalone server event stream                                                                       |
| DELETE /mcp  | SDK 405; no session termination capability because no sessions exist                                                                         |
| OPTIONS /mcp | Guarded browser preflight; exact allowed origin only                                                                                         |
| GET /health  | Deterministic {status: ok}; no dependency probes                                                                                             |
| GET /version | service, version from service package.json, mcpProtocolBaseline and validated environment category                                           |

system.get_status is the only tool. Its Zod input is a strict empty object; unexpected keys are rejected. Its strict output contains service=clientops-mcp, version=0.1.0, status=ok, mcpProtocolBaseline=2025-11-25 and runtime=nodejs-24. The response contains both structuredContent and equivalent text JSON. Read-only/idempotent annotations describe behavior; no data, credentials, machine identifiers or business state is returned or changed. The official client validates the advertised output schema, and the test separately validates the structured result.

## Transport security

The [2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires Origin validation and rejection of invalid Origins, recommends localhost binding for local servers and appropriate authentication. Clients use the negotiated MCP-Protocol-Version on subsequent HTTP requests. Invalid/unsupported versions are rejected; the SDK handles absent-header compatibility.

**Implemented controls:**

- Default bind 127.0.0.1. Explicit MCP_BIND_HOST is required for another bind.
- Explicit Host hostname allowlist, enforced through the official Node SDK guard before every route. Ports are ignored by that guard. X-Forwarded-Host does not override Host.
- Origin, when present, passes the SDK hostname guard and a stricter exact origin allowlist (scheme, hostname and port). Invalid, opaque/null, malformed and unlisted origins return 403. Requests without Origin remain valid non-browser traffic.
- No wildcard CORS. Only an exact approved browser origin is reflected, including preflight; CORS and Origin checks are not authentication.
- Both Node adapter and SDK handler limit bodies to 64 KiB. Invalid configuration fails startup; startup errors do not echo environment values.

See [service configuration](../services/mcp/README.md) for allowlists and local commands. Remote authentication is **planned**, not implemented. This unauthenticated proof must not be publicly deployed. No AWS, Supabase, browser UI or database is involved.

## Automated test matrix

Results below are from successfully executed pnpm test:mcp on 2026-09-28; root pnpm test includes the same tests. Test source: services/mcp/src/protocol.test.ts (HTTP/client/security) and config.test.ts (unit configuration).

| Capability                 | Required            | Test / observed result                                                                                        |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Streamable HTTP            | yes                 | PASS: official client over real TCP; SSE-framed 2025 responses                                                |
| MCP 2025-11-25             | yes                 | PASS: exact request/result negotiation, transport version and legacy era                                      |
| initialize                 | yes for 2025 path   | PASS: initialize 200, notifications/initialized 202                                                           |
| tools/list                 | yes                 | PASS: only system.get_status discovered, schemas present                                                      |
| tools/call                 | yes                 | PASS: structured and text status results match                                                                |
| tool schema validation     | yes                 | PASS: unexpected arguments produce result.isError=true                                                        |
| unknown tool               | yes                 | PASS: SDK JSON-RPC -32602, HTTP 200                                                                           |
| invalid Origin rejection   | yes                 | PASS: foreign host, wrong port/scheme, null and malformed values rejected with 403                            |
| local / missing Origin     | yes                 | PASS: allowed local origins and no-Origin clients succeed                                                     |
| Host protection            | yes                 | PASS: loopback hostnames accepted; foreign/suffix Hosts rejected with 403; forwarded header cannot bypass     |
| local binding              | yes                 | PASS: actual listener address is 127.0.0.1; configuration defaults also asserted                              |
| health endpoint            | project requirement | PASS: exact deterministic response                                                                            |
| version endpoint           | project requirement | PASS: exact public metadata keys and values                                                                   |
| GET / DELETE               | yes                 | PASS: SDK 405 in the stateless path                                                                           |
| wrong Content-Type         | yes                 | PASS: SDK 415 / -32000                                                                                        |
| malformed JSON             | yes                 | PASS: SDK 400 / -32700                                                                                        |
| invalid JSON-RPC           | yes                 | PASS: SDK 400 / -32600                                                                                        |
| incomplete Accept          | additional          | PASS: SDK 406 / -32000                                                                                        |
| unsupported version header | additional          | PASS: SDK 400 / -32000                                                                                        |
| oversized body             | additional          | PASS: 413 before parsing                                                                                      |
| statelessness              | yes                 | PASS: no session header; independent requests and a replacement listener work without retained initialization |
| preflight and route guards | additional          | PASS: approved-origin preflight succeeds; health/version guards and method restrictions enforced              |
| configuration              | additional          | PASS: allowlists, port, baseline and environment validation; unrelated env does not affect public config      |

The compiled pnpm smoke:mcp starts and closes an isolated loopback service and performs the real-client baseline initialize/list/call sequence. It is included in pnpm validate. Inspector commands are documented in the service README; **Inspector verification has not been performed**. GitHub-hosted CI has not run on this unpushed branch. Local tests are the authoritative Phase 1 evidence.

## Scope boundary

No business tools, records, persistence, approval workflows, agent/model calls, cloud integration, MCP Apps or product UI. Do not expose approval resolution through MCP in later phases. This is IMPLEMENTED LOCALLY / VERIFIED infrastructure, not SUBMISSION READY, AWS DEPLOYED or AGENTCORE VERIFIED. Stop after Phase 1.

## Phase 5.1 AgentCore MCP portability

Phase 1 established the historical local protocol proof above. Later phases added five business READ/ANALYZE tools without changing the accepted protocol baseline. Phase 5.1 now implements a cloud-portable MCP runtime while preserving the same `2025-11-25` Streamable HTTP semantics.

### Dual runtime configuration

Local mode remains unchanged by default:

```text
CLIENTOPS_MCP_RUNTIME=local
127.0.0.1:3001/mcp
Host + exact Origin guards
```

Phase 5.1 AgentCore mode is explicitly selected:

```text
CLIENTOPS_MCP_RUNTIME=agentcore
NODE_ENV=production
CLIENTOPS_DATABASE_TARGET=staging
CLIENTOPS_DATABASE_WORKLOAD=mcp
0.0.0.0:8000/mcp
browser Origin rejected
```

AgentCore supplies the managed IAM/SigV4 ingress boundary for machine-to-machine calls. The application does not treat Host/Origin headers as cloud authentication. Direct unauthenticated public exposure of the container remains unauthorized.

### Current tool catalog

The Phase 5.1 runtime exposes exactly six tools:

- `system.get_status` — READ
- `account.get_context` — READ
- `activity.get_recent` — READ
- `commitment.list_open` — READ
- `project.assess_delivery_health` — ANALYZE
- `meeting.prepare_brief` — ANALYZE

There are zero WRITE, approval, denial, execution, EXTERNAL, or DESTRUCTIVE MCP tools.

### Remote data safety

AgentCore MCP startup against staging is gated by exact host/database/TLS validation plus a database-role preflight proving the runtime credential is a `clientops_mcp_reader` member with required SELECT and no mutation privileges.

The default configured service no longer falls back to in-memory data on database failure. Tool failures are converted to bounded safe messages rather than raw database/infrastructure exception strings.

Remote AgentCore certification remains pending until the procedure in `PHASE5_1_RUNBOOK.md` passes. Do not infer Phase 5.2 Agent Runtime, Memory, production identity, or controlled WRITE certification from this MCP deployment work.
