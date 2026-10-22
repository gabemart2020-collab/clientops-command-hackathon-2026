# Phase 5.1 — Non-Production Cloud Data Safety & AgentCore MCP Runtime Runbook

Status: implementation/certification runbook for Phase 5.1.  
Scope: isolated synthetic staging data + model-facing READ/ANALYZE MCP Runtime only.  
No Agent Runtime, Memory, production OIDC, new business actions, EXTERNAL actions, or DESTRUCTIVE actions are authorized.

## 1. Safety invariants

Phase 5.1 must preserve all Phase 4/5.0 boundaries:

- MCP protocol baseline remains exactly `2025-11-25`.
- MCP exposes one READ diagnostic tool plus five READ/ANALYZE business tools.
- MCP exposes zero WRITE, approval, denial, execution, EXTERNAL, or DESTRUCTIVE tools.
- PostgreSQL remains authoritative business truth.
- Only synthetic ClientOps demo data may be used.
- The staging database must be a **brand-new Supabase project created exclusively for ClientOps Command / this hackathon**. Reusing, selecting, migrating into, or connecting Phase 5.1 to any existing Supabase project is prohibited.
- The MCP database credential must be a read-only member of `clientops_mcp_reader`.
- Remote database reset, truncate, delete-all, drop, destructive reseed, and production targets are prohibited.
- The current local `db:reset` and `demo:reset` commands remain local-only.
- Browser-origin requests to the AgentCore MCP container are rejected by application code.
- AgentCore IAM/SigV4 is the external machine-to-machine authorization boundary.

## 2. Required tooling

Use AWS CLI v2, Docker Buildx, PostgreSQL/Supabase access to a dedicated non-production project, and the existing AWS profile used for ClientOps certification.

Recommended environment:

```sh
export AWS_PROFILE=clientops-dev
export AWS_REGION=us-east-1
```

Verify identity without printing credentials:

```sh
aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION"
aws --version
docker buildx version
node --version
pnpm --version
```

Stop if the AWS account/region is not the intended non-production ClientOps target.

## 3. Provision the isolated staging database

Create a brand-new dedicated **ClientOps Command hackathon staging** Supabase project. Do not select, reuse, branch from, migrate into, or connect this phase to any existing Supabase project. This prohibition includes unrelated development, portfolio, scraper, content, commerce, or customer projects.

Record the new project ref/name as the Phase 5.1 target before applying any schema change. Re-verify that project identity before every administrative provisioning step.

Apply the existing additive schema migrations in chronological order from:

```text
supabase/migrations/
```

Do not execute `supabase/seed.sql` remotely because it intentionally contains a destructive `TRUNCATE` for local demo reset.

For the fresh staging project, apply instead:

```text
supabase/staging/002_clientops_demo_seed.sql
```

This file contains synthetic data only and is non-destructive/idempotent (`INSERT ... ON CONFLICT DO NOTHING`).

Then apply:

```text
supabase/staging/001_clientops_mcp_reader.sql
supabase/staging/003_supabase_security_hardening.sql
```

The reader script creates the NOLOGIN group role `clientops_mcp_reader`, grants only SELECT on the ten MCP business tables, and revokes access to the Phase 4 control-plane tables. The Supabase hardening script revokes ClientOps table access from `anon`/`authenticated`, removes future public-schema default grants for those roles, pins the trigger functions' `search_path`, and removes their direct PUBLIC/Data API execution surface.

Create a separate dedicated LOGIN role with a securely generated secret using your staging database administration workflow. The login itself must be non-privileged and inherit only the MCP reader group:

```sql
CREATE ROLE <staging_mcp_login_role>
  LOGIN
  INHERIT
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD '<secure-secret-not-stored-in-repo>';

GRANT clientops_mcp_reader TO <staging_mcp_login_role>;
```

The runtime login must have no other direct role memberships. Do not grant owner, superuser, CREATE, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, approval, execution, or task-mutation authority. Never place the password in source, shell history, the PR, or certification report.

### Data API isolation gate

Phase 5.1 uses direct PostgreSQL access only. It does not require Supabase REST/GraphQL access to ClientOps tables.

Supabase exposes the `public` schema through the Data API by default. Before certification, use the new project's Data API settings to ensure the ClientOps-bearing `public` schema is **not** in the exposed-schema set. Do not add public/browser grants merely to make API probing convenient.

If the project configuration cannot remove `public` from Data API exposure, **stop Phase 5.1 certification**. Do not weaken this requirement or rely only on grant revocation; separately design and review RLS/policies before proceeding.

Using an administrative SQL session, also require this query to return zero rows:

```sql
WITH roles(role_name) AS (
  VALUES ('anon'), ('authenticated')
),
tables(table_name) AS (
  VALUES
    ('organizations'),
    ('users'),
    ('clients'),
    ('projects'),
    ('milestones'),
    ('tasks'),
    ('meetings'),
    ('communications'),
    ('commitments'),
    ('decisions'),
    ('action_proposals'),
    ('action_approvals'),
    ('action_executions'),
    ('audit_events')
)
SELECT role_name, table_name
FROM roles
CROSS JOIN tables
WHERE has_table_privilege(
  role_name,
  format('public.%I', table_name),
  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
)
ORDER BY role_name, table_name;
```

After schema/role provisioning, run the Supabase security advisors and resolve any ClientOps-relevant security finding before remote AgentCore certification. Keep advisor output free of secrets.

## 4. Configure local staging preflight

Export the staging connection only in the current secure shell/session. Never write the value into the repository, report, PR, terminal transcript, or chat.

Required non-secret target guards:

```sh
export CLIENTOPS_DATABASE_TARGET=staging
export CLIENTOPS_DATABASE_WORKLOAD=mcp
export CLIENTOPS_ENVIRONMENT=staging
export CLIENTOPS_STAGING_DB_HOST='<exact-staging-db-host>'
export CLIENTOPS_STAGING_DB_NAME='<exact-staging-db-name>'
export CLIENTOPS_STAGING_DB_USER='<exact-staging-db-user>'

# Download the Server root certificate from the staging project's
# Database Settings -> SSL Configuration.
export CLIENTOPS_STAGING_DB_CA_FILE=/tmp/clientops-supabase-ca.crt
```

Choose the runtime connection path from the **new project's** Supabase Connect panel; never synthesize a hostname from the AWS/Supabase region.

- Prefer the direct PostgreSQL connection for administrative/migration work when the operator network supports the project's direct endpoint.
- For persistent AgentCore application traffic on an IPv4-only path, use the project's **Shared Pooler / Supavisor session mode on port 5432**, not transaction mode on port 6543 unless a later review explicitly changes this contract.
- Supabase supports custom PostgreSQL LOGIN roles through the shared pooler. Validate the dedicated MCP login independently before supplying it to AgentCore.
- Whichever runtime endpoint is selected, copy its exact host, database name, and PostgreSQL username into `CLIENTOPS_STAGING_DB_HOST`, `CLIENTOPS_STAGING_DB_NAME`, and `CLIENTOPS_STAGING_DB_USER`. Do not derive or normalize the username manually; use the exact username from the verified working connection string.

Set the read-only staging connection string in `DATABASE_URL`. Staging deliberately does **not** fall back to `SUPABASE_DB_URL`; a stale environment variable from another project must never become the Phase 5.1 target. The URL must use the exact host/database above and include **exactly `sslmode=verify-full`**.

Phase 5.1 also requires `CLIENTOPS_STAGING_DB_CA_FILE`, pointing to the Supabase **Server root certificate** downloaded from the exact staging project's Database Settings -> SSL Configuration page. The path must be absolute. The CA certificate is public trust material, not a database secret, but do not substitute a certificate from another project or disable verification. The application loads the bounded PEM file and passes it directly to `node-postgres` with `rejectUnauthorized: true`.

Do not rely on `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`, or a process-global `NODE_EXTRA_CA_CERTS` override for AgentCore certification. Local diagnostics may temporarily use `NODE_EXTRA_CA_CERTS`, but the certified runtime contract is the explicit CA file consumed by the application.

Run:

```sh
pnpm staging:mcp:preflight
```

Required output characteristics:

```text
status: ok
target: staging
readerRoleMember: true
schemaUsage: true
schemaCreate: false
readableTables: 10
protectedTables: 14
forbiddenReadTables: 4
otherRoleMemberships: 0
```

The preflight must fail if the connected role is not exactly/directly a `clientops_mcp_reader` member, has any additional direct role membership, lacks required SELECT, has any mutation privilege on protected tables, can SELECT any Phase 4 control-plane table, can CREATE in public schema, has elevated PostgreSQL role attributes, or points at a host/database/user outside the exact staging allowlist.

## 5. Build the AgentCore MCP image

The container contract is:

```text
architecture: linux/arm64
runtime:      Node.js 24
host:         0.0.0.0
port:         8000
path:         /mcp
protocol:     MCP 2025-11-25 Streamable HTTP
mode:         stateless
```

Build from repository root:

```sh
docker buildx build \
  --platform linux/arm64 \
  --secret id=clientops_supabase_ca,src=/tmp/clientops-supabase-ca.crt \
  -f services/mcp/Dockerfile.agentcore \
  -t clientops-mcp:phase5-1 \
  --load \
  .
```

The Dockerfile requires the `clientops_supabase_ca` BuildKit secret and copies that public certificate into the image at `/app/certs/clientops-supabase-ca.crt`; the image sets `CLIENTOPS_STAGING_DB_CA_FILE` to that path. This deliberately avoids spending AgentCore runtime environment-variable capacity on PEM/base64 CA material.

Local container smoke may use the same staging read-only connection and must never use a production target.

## 6. Push to private ECR

Create or reuse a dedicated private ECR repository for the ClientOps MCP staging image.

Example variable shape:

```sh
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --profile "$AWS_PROFILE")"
export ECR_REPOSITORY=clientops-mcp-staging
export IMAGE_TAG=phase5-1
export ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY"
```

Create the repository only if it does not already exist:

```sh
aws ecr describe-repositories \
  --repository-names "$ECR_REPOSITORY" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
```

If absent, create it with image scanning enabled and immutable tags according to the account's normal AWS governance.

Authenticate and push:

```sh
aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker tag clientops-mcp:phase5-1 "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:$IMAGE_TAG"
```

Record the pushed image digest. Certification is pinned to the digest, not a mutable tag.

## 7. AgentCore execution role

Create/use a dedicated AgentCore Runtime execution role whose trust policy permits only `bedrock-agentcore.amazonaws.com` and applies confused-deputy conditions for this AWS account and AgentCore resource scope:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAgentCoreAssumeRole",
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "<AWS_ACCOUNT_ID>" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:bedrock-agentcore:<AWS_REGION>:<AWS_ACCOUNT_ID>:*"
        }
      }
    }
  ]
}
```

The execution role should be least privilege. For this MCP-only runtime, include only the permissions AgentCore requires to pull the exact private ECR image and emit its runtime logs/telemetry. AWS documents ECR image access including `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, and `ecr:GetAuthorizationToken`, plus the relevant CloudWatch Logs/X-Ray/metrics permissions.

Do **not** grant `bedrock:InvokeModel` or `bedrock:InvokeModelWithResponseStream` to this MCP runtime: the Phase 5.1 MCP container does not call a foundation model.

Primary AWS reference:

```text
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html
```

Do not attach administrator, power-user, broad Bedrock model, or unrelated application policies merely for convenience.

## 8. Create the MCP Runtime

Create the runtime with:

- protocol: `MCP`
- container image: exact ECR digest
- network mode: `PUBLIC` for outbound access to the isolated public staging database endpoint during this non-production certification
- inbound authorization: default IAM/SigV4
- runtime environment:
  - `NODE_ENV=production`
  - `CLIENTOPS_MCP_RUNTIME=agentcore`
  - `CLIENTOPS_DATABASE_TARGET=staging`
  - `CLIENTOPS_DATABASE_WORKLOAD=mcp`
  - `CLIENTOPS_ENVIRONMENT=staging`
  - `CLIENTOPS_STAGING_DB_HOST=<exact host>`
  - `CLIENTOPS_STAGING_DB_NAME=<exact database>`
  - `CLIENTOPS_STAGING_DB_USER=<exact PostgreSQL username>`
  - `MCP_PROTOCOL_VERSION=2025-11-25`
  - `MCP_BIND_HOST=0.0.0.0`
  - `MCP_PORT=8000`
  - `DEMO_ORGANIZATION_ID=10000000-0000-4000-8000-000000000001`
  - `CLIENTOPS_DATABASE_URL_SECRET_ARN=<exact Secrets Manager secret ARN>`

Do **not** set `DATABASE_URL` in AgentCore runtime environment variables. Store the exact read-only staging connection string as a Secrets Manager `SecretString` in `us-east-1`; the runtime receives only the secret ARN. The MCP startup path retrieves that one secret using the execution role, validates the resulting URL through the existing exact host/database/user/TLS guard and staging privilege preflight, then removes `DATABASE_URL` from `process.env` after service startup. Never print the secret value or an unfiltered runtime/secret response. The CA remains non-secret trust material baked into the image from the exact staging project at build time.

Current AWS CLI shape:

```sh
aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name clientops_mcp_staging \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<ECR_IMAGE_URI_OR_DIGEST>"}}' \
  --role-arn "<AGENTCORE_EXECUTION_ROLE_ARN>" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --protocol-configuration '{"serverProtocol":"MCP"}' \
  --environment-variables '<BOUNDED_RUNTIME_ENV_JSON>' \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
```

The AgentCore create/update request contains only non-secret runtime configuration and the Secrets Manager ARN. The database credential itself must never appear in AgentCore environment variables, shell history, source, PR text, or certification artifacts.

Important: `GetAgentRuntime` returns the runtime's `environmentVariables` map. Keep that map non-secret and still query only explicitly needed fields in certification output.

### Mandatory MMDSv2 hardening before invocation

Starting June 30, 2026, AWS requires AgentCore Runtime invocations to target an MMDSv2-enabled runtime. A newly created runtime must therefore be checked and, if necessary, updated **before any certification invocation**.

After `create-agent-runtime`, capture `agentRuntimeId`. Then enable MMDSv2 with `UpdateAgentRuntime`. The current CLI update operation requires the runtime ID plus the role/artifact/network values; preserve the same container digest, role, protocol, environment, and network configuration while adding:

```sh
--metadata-configuration '{"requireMMDSV2":true}'
```

A safe pattern is:

1. Keep the original create request values locally and do not source the environment map back from `GetAgentRuntime`.
2. Build the update request from the same artifact/role/network/protocol/non-secret environment values, add the returned `agentRuntimeId`, and add `metadataConfiguration.requireMMDSV2=true`.
3. Call `update-agent-runtime`.
4. Wait for the updated runtime/version to reach `READY`.
5. Query only non-secret fields, for example the runtime ID/ARN/version/status/metadata configuration, and require:

```text
metadataConfiguration.requireMMDSV2 == true
```

Do not invoke the runtime if this assertion is absent or false. Do not use an unfiltered `get-agent-runtime` response in terminal transcripts or certification artifacts because the API response includes `environmentVariables`.

AWS references:

```text
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html
https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore-control/get-agent-runtime.html
```

Record:

- Runtime ARN / runtime ID
- runtime version after MMDSv2 update
- `metadataConfiguration.requireMMDSV2=true`
- exact ECR image digest
- AWS region
- status

Do not expose the database URL.

## 9. Remote MCP certification

Use the AWS CLI v2 `bedrock-agentcore invoke-agent-runtime` operation and the exact Runtime ARN. Use the MCP-specific CLI fields rather than an ambiguous generic invocation where applicable:

```text
--mcp-protocol-version 2025-11-25
--mcp-method <initialize|tools/list|tools/call as applicable>
--mcp-name <tool name for tools/call>
--payload <bounded JSON payload>
<outfile>
```

The CLI returns AgentCore runtime/MCP session metadata separately from the response file. Capture session metadata without treating it as ClientOps business state.

The certification must perform MCP initialization/list/call over the AgentCore runtime and verify the negotiated protocol is `2025-11-25`.

At minimum verify remote discovery contains exactly:

```text
system.get_status
account.get_context
activity.get_recent
commitment.list_open
project.assess_delivery_health
meeting.prepare_brief
```

and zero names containing or equal to:

```text
task.create
approve
deny
execute
write
mutate
delete
send
external
destructive
```

Then invoke all five business tools against the synthetic Acme dataset and verify:

- Acme resolves only in the demo tenant context.
- project health returns the expected deterministic status/evidence.
- open commitments are returned.
- recent activity is returned.
- meeting brief is returned.
- no tool mutates task, proposal, approval, execution, or audit counts.
- the runtime remains stateless at the application layer.
- AgentCore returns an `Mcp-Session-Id` even for stateless MCP; capture/reuse it for runtime affinity/performance, but never treat it as ClientOps business state or authorization.

## 10. Database immutability certification

The MCP reader intentionally cannot SELECT Phase 4 control-plane tables, so **do not weaken its grants just to collect certification counts**.

Using a separate staging-admin/operator SQL session that is never supplied to AgentCore, capture before/after counts for:

```text
tasks
action_proposals
action_approvals
action_executions
audit_events
```

All counts must remain unchanged. Keep the admin credential out of runtime environment variables, source, reports, and shell transcripts.

Separately, using the MCP staging credential, prove mutation denial. Use a harmless no-op-shaped statement so there is no intended row change even if the authorization check were misconfigured:

```sql
BEGIN;
UPDATE tasks SET title = title WHERE false;
ROLLBACK;
```

The expected result is PostgreSQL permission denial on `tasks`; issue `ROLLBACK` afterward because a permission error aborts the transaction. Do not test against customer/production data.

## 11. Required Phase 5.1 report

Report:

1. exact git HEAD
2. PR number
3. AWS account/region (account number may be partially redacted in shared reports)
4. newly created staging project identifier/name without credentials
5. exact staging host/database/user guard identity (no credentials) + verified CA trust configured
6. Data API exposed-schema isolation result + zero `anon`/`authenticated` table privileges
7. Supabase security-advisor result
8. staging database preflight result
9. MCP runtime ARN / ID
10. AgentCore runtime status/version
11. MMDSv2 assertion (`metadataConfiguration.requireMMDSV2=true`)
12. exact ECR image digest
13. remote negotiated MCP protocol
14. remote tool discovery list
15. zero WRITE/approval/execution tools
16. each business tool result summary
17. tenant-isolation result
18. database mutation-count before/after
19. database role mutation-denial proof
20. runtime/application error-leak check
21. CloudWatch/log leak check
22. cleanup status
23. git status
24. final certification status

Final line must be one of:

```text
STATUS: CERTIFIED — PHASE 5.1 AGENTCORE MCP RUNTIME PASSED
```

or

```text
STATUS: FAILED — PHASE 5.1 AGENTCORE MCP RUNTIME NOT CERTIFIED
```

## 12. Stop boundary

Do not begin Phase 5.2.  
Do not deploy the Agent Runtime.  
Do not create AgentCore Memory.  
Do not implement production identity.  
Do not merge the Phase 5.1 PR until code review and remote certification are both complete.
