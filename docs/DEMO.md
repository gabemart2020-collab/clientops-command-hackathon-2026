# ClientOps Command — Local Demo and Screen-Recording Runbook

This document describes the **locally certified October 2026** web demonstration. It is a safe operator runbook, not authorization to run AWS inference, mutate database records, change repository visibility, or deploy anything.

## 1. What judges should see

The Next.js page at `http://localhost:3000/demo` contains two explicit-execution modes:

| Mode                            | Button                       | What runs                                                                                           |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| **Agentic (Bedrock + Strands)** | **Ask ClientOps Agent**      | One `POST /api/agent`, invoking Bedrock and eligible MCP READ/ANALYZE tools                         |
| **Deterministic (reference)**   | **Prepare Executive Review** | One `POST /api/orchestrate`, using two predefined MCP business-tool calls; **no Bedrock inference** |

Page load, account selection, and mode selection **do not automatically call** either API endpoint. Changing accounts or modes clears the previous briefing.

The **Acme Labs** synthetic hero scenario has a fixed clock, **2026-10-15 09:00 UTC**, and an Executive Review meeting on **2026-10-16 at 14:00 UTC**. The prefilled prompt, `Prepare me for tomorrow's Acme review.`, refers to that fixed scenario date.

Expected risk narrative:

- **AT RISK:** Production Data Migration milestone overdue by two scenario days.
- **Unresolved client inquiry:** “Discrepancy in Q3 Analytics Export.”
- **Open commitment:** Updated cutover rollback runbook, due October 18 within the scenario.
- **Positive progress:** Recently completed migration-related tasks and updated client communications.

Results can vary in Agentic Mode. Only make claims supported by the specific captured run.

## 2. Guardrails and prerequisites

- **Never** expose Codespaces ports 3000 or 3001 as public. Both must remain **Private**.
- **Never** commit AWS credentials, database passwords for real environments, or secret-bearing terminal output.
- Keep `CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false` and `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=false` for this rehearsal and screen recording. This prevents guarded web proposal registration and approval/decision execution; it is **not** a global database read-only mechanism.
- The MCP model-facing tool list includes only five authorized business READ/ANALYZE tools; approval and task execution do **not** take place through MCP.
- Do not click approval/denial buttons or experiment with action-creation prompts during the read-only recording.
- Use the existing **local** PostgreSQL dataset. Do not reset, migrate, reseed, or replace a certified dataset. `pnpm demo:reset` is destructive to local demo contents and reserved for a **fresh, disposable local database**, separately authorized by its operator.
- Running Next.js with an authorized AWS profile makes a deliberate `/api/agent` click **billable**. Start with the credential-isolated configuration and agree on a precise invocation budget before restarting with credentials.
- Never launch the MCP server in AgentCore/staging mode for this local demonstration.

Requirements: Node.js **24.x**, pnpm **12.3.4**, Docker/PostgreSQL 16, and a browser. If needed, `pnpm install --frozen-lockfile` installs dependencies without changing the lockfile.

## 3. Start or reuse the local database

In a Codespaces terminal:

```sh
cd /workspaces/clientops-command
git branch --show-current
git status --short

# If the local demo container is stopped, start it without resetting data:
docker ps -a --filter name=clientops-postgres --format 'table {{.Names}}\t{{.Status}}'
docker start clientops-postgres

# Wait for its startup; initial "no response" can be transient.
docker exec clientops-postgres pg_isready -U postgres -d clientops_dev
```

### First-time judge setup — fresh disposable database only

In a newly created, isolated local environment, confirm that the target database contains no records requiring preservation. Only after this confirmation, initialize the local container and synthetic Acme Labs dataset:

```sh
pnpm db:start
pnpm demo:reset
```

**Warning:** `pnpm demo:reset` applies migrations and runs `supabase/seed.sql`, including `TRUNCATE ... CASCADE`. This replaces local demo data. Never execute it against our existing certified database, staging, production, or another non-disposable database.

For existing installations, use the non-destructive startup instructions above instead. The fresh-installation procedure still requires separate verification before certification.

## 4. Terminal 1 — start the local MCP service

```sh
cd /workspaces/clientops-command

CLIENTOPS_MCP_RUNTIME=local \
CLIENTOPS_DATABASE_TARGET=local \
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev" \
DEMO_ORGANIZATION_ID="10000000-0000-4000-8000-000000000001" \
MCP_BIND_HOST=127.0.0.1 \
MCP_PORT=3001 \
pnpm dev:mcp
```

This example URL is exclusively for the **disposable local development container** and is **not** a cloud or production credential. From another terminal:

```sh
curl -fsS http://127.0.0.1:3001/health
# Expected: {"status":"ok"}
```

Keep Terminal 1 running.

## 5. Terminal 3 — credential-isolated browser exploration

The following starts the browser interface **without a usable AWS credential chain**, so an accidental Agentic button click cannot make a successful Bedrock call. It does not disable the deterministic MCP workflow.

```sh
cd /workspaces/clientops-command

env \
  -u AWS_ACCESS_KEY_ID \
  -u AWS_SECRET_ACCESS_KEY \
  -u AWS_SESSION_TOKEN \
  -u AWS_WEB_IDENTITY_TOKEN_FILE \
  -u AWS_ROLE_ARN \
  AWS_PROFILE=clientops-browser-no-credentials \
  AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_CONFIG_FILE=/dev/null \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_REGION=us-east-1 \
  CLIENTOPS_MCP_URL=http://127.0.0.1:3001/mcp \
  CLIENTOPS_DATABASE_TARGET=local \
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev \
  CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false \
  CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=false \
  pnpm dev:web
```

After Next.js reports `Ready`, open the **private** forwarded port 3000 at `/demo`.

**First rehearsal:** Choose Acme Labs → Deterministic Mode → **Prepare Executive Review**. Inspect the two risk findings, six briefing points, evidence drawers, one open commitment, recent activity, and two `[OK]` MCP calls. DevTools should show one `POST /api/orchestrate` with status 200, assuming the database and MCP server are healthy.

**No-auto-dispatch check:** Reload the page, change mode, and change account selection without clicking a workflow button. Verify there is no automatic `POST /api/agent` or `POST /api/orchestrate` in DevTools Network.

## 6. Deliberately enable exactly one live Bedrock briefing

**Separate operator authorization required.** After rehearsal, stop Terminal 3 with `Ctrl+C`. To carry out a specifically approved live invocation, restart only Terminal 3 with the verified **non-root** AWS profile that is authorized for the selected Bedrock model.

```sh
cd /workspaces/clientops-command

env \
  -u AWS_ACCESS_KEY_ID \
  -u AWS_SECRET_ACCESS_KEY \
  -u AWS_SESSION_TOKEN \
  -u AWS_WEB_IDENTITY_TOKEN_FILE \
  -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE \
  -u AWS_CONFIG_FILE \
  AWS_PROFILE=clientops-dev \
  AWS_REGION=us-east-1 \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_PAGER="" \
  BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6 \
  AGENT_MAX_TOTAL_TOKENS=32000 \
  AGENT_MAX_OUTPUT_TOKENS=2000 \
  AGENT_MAX_TURNS=6 \
  AGENT_TIMEOUT_MS=30000 \
  CLIENTOPS_MCP_URL=http://127.0.0.1:3001/mcp \
  CLIENTOPS_DATABASE_TARGET=local \
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev \
  CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false \
  CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=false \
  pnpm dev:web
```

Use `clientops-dev` **only if it is the operator's verified, non-root, authorized profile**; otherwise use a separately verified least-privilege profile. Do not execute identity/IAM lookups or run extra model requests without permission.

Open `/demo`, select **Acme Labs**, stay in **Agentic Mode**, retain the scenario prompt, and press **Ask ClientOps Agent** **once**. Wait for the response. Do not double-click or automatically retry on a failure. On a successful run, inspect:

1. Amazon Bedrock provider/model, latency, and token usage.
2. “Grounding Verified” and the unsupported-evidence count.
3. Acme Labs executive answer, `AT RISK`, findings, and suggested next steps.
4. At least one expanded authoritative evidence reference.
5. The agentic MCP trace and `[OK]` tool statuses.
6. DevTools Network `POST /api/agent` HTTP status.

The October 2026 browser certification observed **HTTP 200**, **five successful MCP tools**, **six findings**, **six recommendations**, **zero unsupported evidence**, approximately **16 seconds model-reported latency**, and **25,397 total tokens**. Do not treat these as fixed output requirements for every future invocation. A new model request must be individually or batch-authorized before running it.

**After filming:** stop the Bedrock-enabled Next.js server immediately; if continuing to explore, restart under Section 5's credential-isolated configuration. Stop the MCP service and Codespace when finished.

## 7. Suggested under-three-minute recording sequence

| Time      | On screen                                 | Message                                                          |
| --------- | ----------------------------------------- | ---------------------------------------------------------------- |
| 0:00–0:20 | ClientOps Command title and Acme selector | Why executive review prep needs trustworthy operational context  |
| 0:20–0:50 | Acme agent prompt and deliberate click    | Strands/Bedrock reasons and discovers authorized MCP tools       |
| 0:50–1:23 | AT RISK executive briefing                | Overdue milestone, analytics discrepancy, commitment             |
| 1:23–1:58 | Evidence drawer and five-tool trace       | Verifiable records and dynamic MCP execution                     |
| 1:58–2:26 | Architecture slide / simple diagram       | MCP 2025-11-25, Bedrock, Strands, PostgreSQL and human authority |
| 2:26–2:45 | Final product screen                      | Practical value, limits, and trustworthy design                  |

Capture real product operation; graphics should explain, not substitute for actual footage. Exclude credentials, private organization identifiers, system secrets, cloud dashboards, and copyrighted/unlicensed music. The uploaded YouTube/Vimeo video must be **public** and **under three minutes**.

## 8. Troubleshooting and known limitations

- **MCP health fails:** Check Terminal 1 and local database readiness; do not reset the database to “fix” connectivity.
- **AWS/Bedrock authorization error:** Stop. Validate the intentionally selected non-root profile/model configuration separately; do not try default/root identities.
- **Model configuration:** The current source defaults to an **older Claude 3.5 Sonnet** model and a 12,000-token application budget; Section 6 overrides both with the previously certified model and budget. Avoid invoking the agent with defaults.
- **Action requests:** With `CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false`, proposals/decision writes through the guarded web routes fail closed. The guard does **not** prevent the model invocation itself and does not globally lock the database.
- **Date display:** “Tomorrow” is relative to the frozen 2026-10-15 demo clock.
- **Public hosting:** The app is a local/private dev demonstration, not a publicly deployed production service.

For competition rules, licensing, and review access, see [SUBMISSION.md](SUBMISSION.md).
