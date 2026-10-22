# ClientOps Command

**Evidence-grounded AI client operations with Amazon Bedrock, Strands Agents TypeScript, and MCP over Streamable HTTP.**

Built for the [Amazon Build, Ship, Shape Developer Hackathon 2026](https://amazonappdev2026.devpost.com/), targeting the **Alexa+ self-hosted MCP server** primary track and the **AWS Builder** mini challenge. This is a working MCP-server submission with a local web demonstration, **not** a deployed Alexa+ Agent Skill or production Alexa+ integration.

## For Hackathon Judges — Start Here

This source snapshot supports a local, reproducible demonstration.

1. Follow [the local demo runbook](docs/DEMO.md) for installation, synthetic data, and the Next.js/MCP startup commands.
2. Open `http://localhost:3000/demo`, select **Acme Labs**, choose **Deterministic Mode**, and click **Prepare Executive Review**.
3. Inspect the risk findings, authoritative evidence, and successful MCP tool trace.
4. Review [Gate 3B reproducibility](docs/GATE3B_REPRODUCIBILITY.md) for automated fresh-runner browser certification.
5. Watch the [published Bedrock + Strands demonstration](https://youtu.be/HyUAR6tCCYQ).

Deterministic Mode needs no AWS credentials. Live Agentic Mode requires the judge's own authorized Bedrock configuration and may incur AWS charges. Keep MCP, Next.js, and PostgreSQL ports private.

## What it does

ClientOps Command helps a team prepare for a client executive review by combining authoritative account records, delivery risks, recent activity, and commitments. The demo prompt is:

> Prepare me for tomorrow's Acme review.

The **Acme Labs** scenario deliberately freezes its clock at **2026-10-15 09:00 UTC**. Its executive review takes place on **2026-10-16 at 14:00 UTC**; “tomorrow” refers to that scenario, not today's calendar date.

The Next.js interface at `/demo` has two modes:

- **Agentic:** Strands Agents TypeScript calls Amazon Bedrock and chooses from five authorized MCP READ/ANALYZE business tools. The page shows a structured executive briefing, evidence drawers, runtime metadata, and a sanitized MCP trace.
- **Deterministic:** A reference workflow makes two defined MCP business-tool calls without an LLM, displaying a briefing and source evidence for comparison.

Workflows execute **only after the user presses the corresponding button**. Changing the selected account or mode does not invoke Bedrock or MCP.

## Architecture and trust boundaries

```text
User -> Next.js /demo
         |-- explicit Agentic request -> Strands TS -> Amazon Bedrock
         |                                  |
         |                             MCP tool calls
         |                                  |
         |-- explicit Deterministic request -> MCP client
                                            |
                          Streamable HTTP /mcp (2025-11-25)
                                            |
                                  domain READ/ANALYZE tools
                                            |
                              authoritative PostgreSQL records
                                            |
                              typed evidence refs + grounded brief
```

The five agent-allowlisted business tools are `account.get_context`, `activity.get_recent`, `commitment.list_open`, `project.assess_delivery_health`, and `meeting.prepare_brief`. The separate diagnostic `system.get_status` tool is not agent-allowlisted. Deterministic domain logic owns delivery-health rules; model-generated wording is not authoritative business state.

The repository also contains a governed `task.create` action-proposal, human-approval, private-executor, and append-only audit architecture. **The recommended judge and filming configuration sets `CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false`**, which disables proposal registration and approval/decision execution through the guarded web routes. The model has no WRITE or approval MCP tools. This setting is not a universal read-only switch for every possible application or database operation. Production authentication and public application hosting are not implemented.

See [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), and [tool contracts](docs/TOOL_CONTRACTS.md).

## Verified demonstration results

The local October 2026 **live browser** check completed one `POST /api/agent` with HTTP 200 using Bedrock model `us.anthropic.claude-sonnet-4-6`. The observed response displayed **five successful business MCP calls**, **six evidence-grounded findings**, **six suggested next steps**, and **zero unsupported evidence references**. Model-reported latency was approximately **16 seconds** and usage was **25,397 tokens** under an application limit of 32,000. These are observations, not guaranteed future output.

The **deterministic UI** check returned HTTP 200 from `/api/orchestrate`, with two successful MCP calls, two risk findings, and six briefing points. A post-browser PostgreSQL query matched the previous local row-count baseline: **9 action proposals, 36 audit events, 8 tasks**. Matching counts establish no _net row-count change_ in those tables; they do not prove existing rows were unmodified.

PR #14 introduced explicit-only browser execution and default-deny web action-write controls. Its reviewed CI run passed **620 tests across 36 files**. These checks do not imply production deployment or that new setups are already certified.

## Local setup

**Requirements:** Node.js 24.x, pnpm 12.3.4, Docker (PostgreSQL 16), and a web browser. Running Agentic Mode additionally requires your own **server-side** AWS profile authorized for Bedrock inference in `us-east-1`. Never place AWS credentials in source code, screenshots, public URLs, or browser-accessible environment variables.

```sh
pnpm install --frozen-lockfile
```

**Existing certified local database:** Start or reuse the local PostgreSQL container without replacing its contents. Do not reset, reseed, or migrate an existing certified database merely to launch the demonstration.

```sh
pnpm db:start
```

**Fresh, disposable judge installation:** In a new, isolated local environment with no data requiring preservation, initialize the local PostgreSQL container and synthetic demonstration dataset using `pnpm db:start`, followed by `pnpm demo:reset`.

**Destructive operation warning:** `pnpm demo:reset` applies migrations and runs `supabase/seed.sql`, which contains `TRUNCATE ... CASCADE` and replaces existing demo data. Never use it against our certified database, staging, production, or any database containing records that must be preserved. The original source passed Gate 3B fresh-runner certification; this release snapshot requires its own verification.

Follow the detailed **[safe demo and recording runbook](docs/DEMO.md)** for copyable MCP and Next.js commands, no-credential exploration, and explicitly authorized live Bedrock invocation. Keep forwarded development ports private.

**Offline validation (does not deliberately invoke Bedrock):**

```sh
pnpm validate
pnpm build:web
pnpm build:agent-runtime
```

Do not confuse this with `pnpm smoke:agent:live` or `pnpm eval:agent:live`: those make deliberate, potentially billable live-model requests.

## Repository map

- `apps/web`: Next.js demo and server-side API/action boundaries.
- `packages/agent`: Strands/Bedrock orchestration, grounding, tool allowlist.
- `services/mcp`: MCP Streamable HTTP server and READ/ANALYZE tool surface.
- `packages/domain`, `packages/data`: Deterministic business rules and PostgreSQL persistence.
- `packages/contracts`, `packages/policy`, `packages/audit`: Contracts, governed actions, and audit.
- `services/agent-runtime`: Separately governed staging runtime implementation.
- `supabase`, `scripts`, `tests`, `docs`: Schemas, synthetic demo data, verification, and runbooks.

## Submission and limitations

See [submission information](docs/SUBMISSION.md) and [hackathon requirements](docs/HACKATHON_REQUIREMENTS.md).

This folder is an isolated, history-free submission candidate. It is not yet cleared for public release. Its original development repository remains private. Publication requires separate approval.

The current agent config source retains an older **Claude 3.5 Sonnet default** and a **12,000-token default budget**. Live demonstrations must set an available Bedrock model and a proven budget explicitly, as in [docs/DEMO.md](docs/DEMO.md). Cloud/staging architecture documentation and offline certifications do **not** establish public production availability.

## License

Copyright 2026 Gabriel Martinez.

Licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for the complete terms.

Third-party dependency attribution is documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
