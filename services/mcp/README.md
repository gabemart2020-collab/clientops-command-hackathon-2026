# @clientops/mcp — Streamable HTTP service

ClientOps model-facing MCP service on Node.js 24.x using the official Model Context Protocol TypeScript SDK. The certified protocol baseline remains exactly `2025-11-25`.

## Registered tools

| Tool Name                        | Action Class | Description                                                                                          |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `system.get_status`              | READ         | Health, protocol baseline, and runtime check.                                                        |
| `account.get_context`            | READ         | Resolves client identity, active projects, upcoming meetings, open commitments, and metric counts.   |
| `activity.get_recent`            | READ         | Chronological audit/activity feed for an account.                                                    |
| `commitment.list_open`           | READ         | Lists active open commitments for an account.                                                        |
| `project.assess_delivery_health` | ANALYZE      | Evaluates project delivery health and material risk findings with evidence references.               |
| `meeting.prepare_brief`          | ANALYZE      | Generates deterministic briefing pack, factual talking points, and evidence for an upcoming meeting. |

Zero WRITE, approval, denial, execution, EXTERNAL, or DESTRUCTIVE MCP tools are registered.

## Local mode

```sh
pnpm dev:mcp
```

Defaults to `http://127.0.0.1:3001/mcp` with `GET /health` and `GET /version`.

Local security controls:

- loopback bind by default;
- exact Host and Origin allowlists;
- no wildcard CORS;
- 64 KiB request body bound;
- stateless MCP handler;
- PostgreSQL configuration failures fail closed rather than silently switching to in-memory data.

## Phase 5.1 AgentCore mode

Phase 5.1 adds a separate cloud runtime configuration while preserving the same tool catalog and protocol semantics.

Container contract:

```text
runtime:   Node.js 24
platform:  linux/arm64
bind:      0.0.0.0
port:      8000
path:      /mcp
protocol:  2025-11-25
mode:      stateless Streamable HTTP
```

The image is `services/mcp/Dockerfile.agentcore`.

Required runtime configuration includes:

```text
NODE_ENV=production
CLIENTOPS_MCP_RUNTIME=agentcore
CLIENTOPS_DATABASE_TARGET=staging
CLIENTOPS_DATABASE_WORKLOAD=mcp
CLIENTOPS_ENVIRONMENT=staging
CLIENTOPS_STAGING_DB_HOST=<exact host>
CLIENTOPS_STAGING_DB_NAME=<exact database>
MCP_PROTOCOL_VERSION=2025-11-25
MCP_BIND_HOST=0.0.0.0
MCP_PORT=8000
```

AgentCore mode is machine-to-machine only. Browser requests carrying an `Origin` header are rejected by application code. AgentCore IAM/SigV4 is the intended managed ingress authorization boundary.

## Staging database safety

The MCP runtime may connect remotely only when the explicit staging policy passes:

- `CLIENTOPS_DATABASE_TARGET=staging`;
- `CLIENTOPS_DATABASE_WORKLOAD=mcp`;
- `CLIENTOPS_ENVIRONMENT=staging`;
- exact configured non-local host;
- exact configured database name;
- PostgreSQL TLS mode `require`, `verify-ca`, or `verify-full`.

Before the staging MCP listener starts, the connected database role must pass `assertMcpReaderDatabasePrivileges`:

- membership in `clientops_mcp_reader`;
- USAGE on the public schema;
- SELECT on the ten business tables used by MCP;
- zero INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privilege on protected business/control-plane tables;
- zero SELECT privilege on Phase 4 control-plane tables;
- zero CREATE privilege on the public schema.

Run a direct preflight with:

```sh
pnpm staging:mcp:preflight
```

Do not run `supabase/seed.sql`, `pnpm db:reset`, or `pnpm demo:reset` against staging. The approved synthetic remote seed is `supabase/staging/002_clientops_demo_seed.sql`, which is non-destructive and idempotent.

## Validation

```sh
pnpm test:mcp
pnpm smoke:mcp
pnpm test:data
pnpm validate
pnpm build:web
```

The compiled smoke test remains local and uses the official MCP client. Remote AgentCore certification is a separate Phase 5.1 gate described in `docs/PHASE5_1_RUNBOOK.md`.

Phase 5.2 Agent Runtime work is not authorized by Phase 5.1.
