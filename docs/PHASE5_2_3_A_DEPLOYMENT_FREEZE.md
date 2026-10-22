# Phase 5.2.3-A — Contract, IAM, and Trusted Caller Freeze

Status: Gate A security/governance freeze — **NOT DEPLOYABLE**. Architecture and offline contracts only; no AWS provisioning, deployment, production identity, database migration, remote invocation, or live proposal writes authorized. A green CI result does not grant deployment authority.

Baseline: `main@2571747e56c0c9b6f5535bbc0ae09be6c7d6e832`.

## 1. Invariants

- Agent Runtime may reason, use exactly five READ/ANALYZE MCP business tools, ground evidence, and register a `PENDING_APPROVAL` proposal. It cannot approve, execute, or mutate tasks.
- Phase 5.1 MCP Runtime version 2, image, role, database reader identity, and catalog are immutable dependencies.
- Staging-only synthetic certification organization/actor. No production OIDC, memory, direct browser access, or general multi-tenant endpoint.
- No model, browser, or caller-provided text can assign authority, tenant, actor, or request ownership.
- All runtime responses/logs are sanitized; the authoritative evidence resolver never leaves the runtime invocation boundary.

## 2. Trusted caller and idempotency ownership

Use a dedicated, server-side staging certification caller. It authenticates to the AgentCore data plane using AWS IAM/SigV4 and is allowlisted to invoke only the exact staging Agent Runtime ARN. No direct browser or arbitrary public client invocation.

The caller, not the browser/model/request body, sets `organizationId`, `actorId`, `sessionId`, and `requestId` from trusted certification context. An invocation is bound to a stable canonical payload fingerprint and a caller-owned request record. The same authorized logical invocation may retry using its original request ID; a different payload, principal, organization, or actor must fail closed. A fresh request gets a fresh ID.

IAM authentication of the data-plane caller alone does **not** authenticate arbitrary fields inside the JSON body. Before remote enablement, demonstrate a server-controlled construction path and tests proving that an untrusted party cannot supply or replay another request ID. If any client-controlled path can reach the runtime, add a separately verified authenticated envelope or gateway binding; never trust forwarded identity headers without a verified intermediary.

Durable proposal idempotency remains first-write-wins on `(organization_id, correlation_id)`, with no duplicate proposal or audit events on retry. It is not a substitute for authorization.

## 3. IAM authority matrix (design, not deployed)

| Principal                    | Allowed                                                                                                                                                                                                                             | Explicitly excluded                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Staging certification caller | `bedrock-agentcore:InvokeAgentRuntime` on exact new Agent Runtime ARN and qualifier as supported                                                                                                                                    | Invoking unrelated runtimes; `InvokeAgentRuntimeForUser`; secrets; DB administration; approval/execution |
| Agent Runtime execution role | Required Bedrock model/inference-profile invocation, `bedrock-agentcore:InvokeAgentRuntime` on exact certified MCP Runtime, `secretsmanager:GetSecretValue` on exact proposer secret, bounded logging and necessary image retrieval | Approval/execution; broad secret access; mutation of IAM/ECR/AgentCore; `InvokeAgentRuntimeForUser`      |
| Deployment principal         | Explicitly approved ECR push and AgentCore/IAM provisioning operations for new staging resources                                                                                                                                    | Unrelated MCP runtime changes, production resources, database privilege expansion                        |
| MCP Runtime role             | Existing Phase 5.1 certified READ/ANALYZE authority, unchanged                                                                                                                                                                      | Any Phase 5.2.3 permission expansion                                                                     |
| Proposer PostgreSQL login    | Existing certified proposal insert, limited lifecycle update, restricted audit insert and required reads                                                                                                                            | Task/approval/execution writes; schema changes; elevated membership                                      |

The `iam-policy-candidate.ts` document is a **partial, non-executable permission candidate**, covering only AgentCore MCP invocation and proposer-secret read. Its offline guardrail tests do not certify an entire IAM execution role, trust relationship, caller role, Bedrock model access, image retrieval, or logging permissions. No generated policy may be deployed from this candidate without a separately reviewed complete policy and AWS authorization validation.

Before creating IAM policies, validate each AWS action, resource type, trust principal, required backing model ARN, and condition key against live AWS service authorization documentation. Where resource scoping is unsupported, document the exception and apply supported conditions, boundaries, and role separation. Never invent ARN patterns or claim that an untested policy is least privilege.

## 4. Runtime configuration and packaging contract

- AgentCore HTTP: `0.0.0.0:8080`, `GET /ping`, `POST /invocations`; Linux ARM64, Node.js 24, non-root.
- Use a private ECR repository with immutable tags, vulnerability scanning, and a digest-pinned runtime image.
- Dedicated Agent Runtime execution role; MMDSv2 required.
- AWS region `us-east-1`; model `us.anthropic.claude-sonnet-4-6`; exact certified Phase 5.1 MCP ARN from `docs/PHASE5_2_RUNBOOK.md`.
- Only non-secret runtime environment variables. Load the existing dedicated proposer secret at runtime via Secrets Manager; never print it, bake it into an image, or copy it to deployment output.
- The current `services/agent-runtime/src/main.ts` intentionally uses an unbound MCP invoker and no concrete registrar. Gate B must replace both bindings and fail closed on missing configuration.
- Do not deploy until exact-head tests, image provenance, and scan review pass.

## 5. Required Gate A negative tests and evidence

1. A mismatched synthetic organization/actor is rejected before MCP/model/proposal work.
2. A browser/model/untrusted request cannot select certification IDs, session ID, or request ID.
3. A different authenticated caller cannot claim or retry an owned request ID.
4. A same-caller replay with altered canonical payload is rejected without a new proposal or audit.
5. A same-caller identical retry preserves its original request ID and proposal idempotency.
6. Missing, malformed, or unverified caller context fails closed.
7. IAM policy assertions exclude wildcard AgentCore invocation, broad secret reads, `InvokeAgentRuntimeForUser`, and approval/execution actions.
8. Logging/error paths exclude credentials, raw MCP evidence, SQL errors, and approval binding hashes.

Evidence map: `trusted-caller-policy.test.ts` exercises strict untrusted input, synthetic identity, same-caller retries, changed payloads, unknown request IDs (including valid UUIDs), defensive-copy immutability, and caller mismatch; `iam-policy-guardrails.test.ts` exercises disallowed IAM actions/resources and malformed policy structures. These are **offline contract tests**, not verified AWS identity or remote ingress tests. In `handler.test.ts`, `never leaks SQL exception details to logs or response` injects SQLSTATE, duplicate-key, constraint, detail, and statement text, then asserts those details are absent from the serialized public response and logger calls. `redacts untrusted exception names and messages across runtime failure boundaries` covers credentials, raw MCP evidence, and approval binding hashes across those same surfaces. These tests are sanitization evidence only; they do not establish database or cloud behavior. Record exact-head CI results before claiming Gate A complete. Do not mark this requirement satisfied solely from documentation or local tests.

Gate A is complete only after all applicable contracts have executable evidence, the sanitization coverage map is verified, CI passes on the exact branch head, and the PR receives final review. No cloud resources may be created during Gate A.

## 6. Subsequent gates and stop conditions

- **B:** Bind concrete AgentCore SDK invoker and proposer registrar, with tested trusted caller implementation; offline tests first. **Mandatory blockers before any remote invocation:** authenticate the actual caller principal using a verified AWS identity path (not a caller-populated `verifiedPrincipalArn` object); ensure the trusted server alone owns organization/actor/session/request IDs; enforce caller-authorized retry ownership; replace `InMemoryCallerOwnershipStore` with durable, atomic first-write-wins storage with restart/concurrency tests; prove the full runtime and caller IAM policies and trust policies are correctly scoped. No browser/model/user-provided context may be promoted to trusted identity.
- **C:** Produce and scan exact-head ARM64 container image; review supply-chain evidence.
- **D:** Provision separately authorized staging ECR, IAM, and logging resources; certify scope.
- **E:** Deploy digest-pinned AgentCore HTTP Runtime with MMDSv2 and constrained ingress.
- **F:** Certify remote caller authorization, health, tool isolation, and sanitized errors without live proposal writes.

Phase 5.2.4 remains the separately authorized remote proposal write/retry/tenant-isolation certification. Any failure in trusted request ownership or IAM scope blocks deployment and invocation.

## 7. Rollback

Before enabling a remote caller, record the exact runtime, role, image digest, and configuration identifiers. On failure, disable caller invocation and stop/remove only the newly created Agent Runtime. Leave Phase 5.1 MCP, proposer database roles/triggers, Secrets Manager credential, and production unchanged. Never print or store secrets in rollback logs.
