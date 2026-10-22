# ClientOps Command — Hackathon Submission Readiness

**State (2026-10-22): PRIVATE SNAPSHOT CI CERTIFIED; DEVPOST NOT SUBMITTED.** The owner verified the public YouTube video (2:56.68). The isolated, history-free submission repository passed [Validate](https://github.com/gabemart2020-collab/clientops-command-hackathon-2026/actions/runs/39814525827) and [Gate 3B](https://github.com/gabemart2020-collab/clientops-command-hackathon-2026/actions/runs/39814525695) on root commit `e4c041f501f948c5e6e61919e85fe1de2724b89c`. Public visibility and Devpost submission require separate owner approval.

**Primary track:** Alexa+ — **self-hosted MCP server**, using the official MCP **2025-11-25** protocol baseline and Streamable HTTP. The adjacent Next.js UI demonstrates the MCP-backed agent. **Do not claim** an Alexa+ Agent Skill or deployed Alexa+ integration.

**Mini challenge:** AWS Builder — Amazon Bedrock + Strands Agents TypeScript have been invoked in the local working application. Qualifying services and the observed developer experience must be described in the Product Feedback answer. Do not claim AgentCore deployment/runtime certification unless independently verified for the exact deployed target.

**Deadline:** Friday **October 23, 2026, 12:00 PM PDT** (**3:00 PM EDT**). Target **October 22** for submission to leave a buffer.

Official requirements: [rules](https://amazonappdev2026.devpost.com/rules), [submission overview](https://amazonappdev2026.devpost.com/), and [FAQ](https://amazonappdev2026.devpost.com/details/faqs). Re-verify the live submission form immediately before submitting.

## 1. Certified implementation evidence

The following reflects completed local checks, not production/cloud deployment:

- PR #14 browser-safety gate merged into `main` at `8b8b853751e350402b661b8c9b0287f1c39b24d6`.
- CI for PR #14 passed **620 tests across 36 files**, plus its configured validation/build jobs.
- `/demo` loads and account/mode selections make **no automatic** `POST /api/agent` or `POST /api/orchestrate` requests.
- Deliberately invoked Bedrock model `us.anthropic.claude-sonnet-4-6` via Strands from the Next.js browser: `POST /api/agent`, **HTTP 200**; five successful business MCP tool calls; six evidence-grounded findings; zero unsupported evidence references; model-reported latency approximately 16 seconds.
- Deterministic workflow: `POST /api/orchestrate`, HTTP 200, two successful business MCP tools, two risk findings.
- After the agentic browser check, read-only PostgreSQL counts matched their baseline: `action_proposals=9`, `audit_events=36`, `tasks=8`. Matching counts only establish no net change in row counts, not proof of immutable rows.
- Browser recording configuration explicitly sets `CLIENTOPS_WEB_ACTION_WRITES_ENABLED=false` and `CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=false`. The model has no WRITE/approval MCP tools.

The synthetic fixed-clock Acme Labs scenario is documented in [DEMO.md](DEMO.md). Do not use genuine client information or actual AWS/database secrets in submitted media.

## 2. Final deliverables — still to complete

- [ ] Confirm individual/team eligibility and that submission account/track selections are correct.
- [ ] Resolve the repository publishing option: **public with a visible open-source license** or **private with accepted access for all required reviewers**. Both paths require explicit owner approval; complete the independent source/security review before release.
- [x] Independently verify clean installation, disposable local demo dataset, validation/build jobs, and deterministic browser instructions on fresh GitHub-hosted runners without developer-only secrets. Manual judge setup remains documented in [DEMO.md](DEMO.md).
- [x] Demonstration video URL recorded for review: https://youtu.be/HyUAR6tCCYQ (public access, content, language, duration, and potential sensitive information require independent verification).
- [x] Owner verified the published demonstration video and its 2:56.68 duration.
- [ ] Prepare text description: problem, target users, user workflow, verified features, AWS/MCP architecture, constraints, and measurable proof from the actual demo.
- [ ] Prepare **Product Feedback** for every Amazon API/SDK/service used: what for, what worked, shortcomings, onboarding, and willingness to build with it again. Include the specific AWS Builder integrations.
- [ ] Consider optional friction-log entries, with observed steps, expected/actual outcome, severity, workaround, and useful suggestions. Do not invent problems or improvements.
- [ ] Enter code repository URL, public video URL, primary track, mini challenge, and required product details into the actual Devpost submission form.
- [ ] Verify links/access from a separate signed-out/reviewer-like session, and submit **before** the official deadline; retain confirmation.

A public repository is not automatically a public deployment. The local/private MCP demonstration should be clearly described and reproducible from the repository.

## 3. Release snapshot and reviewer access

The original engineering repository remains private.

The preferred submission route is a separately reviewed, history-free
source repository with an Apache-2.0 license and independently verified
installation instructions.

The source snapshot must be cleared for public disclosure, undergo its
own CI/browser certification, and receive explicit publication approval.
Until then, it must remain private.

If the public route cannot be cleared, the fallback is a separately
authorized private reviewer-access process using an isolated repository.

No reviewer invitations or Devpost submission are authorized by this document.

## 4. Judge-facing explanation

**Problem:** Client teams preparing executive reviews must reconcile account history, milestones, inquiries, open commitments, and delivery risk. Missing context can produce incomplete or unreliable briefings.

**Demonstrated solution:** ClientOps Command provides a real Bedrock/Strands agent using five MCP READ/ANALYZE tools over Streamable HTTP. Domain repositories return typed source records and evidence references; a grounding validator rejects unsupported evidence references. Next.js presents a briefing, risk findings, authoritative evidence, and a sanitized MCP trace. A non-LLM deterministic reference mode demonstrates baseline functionality.

**Governance:** The LLM cannot approve or execute a business action through MCP. An isolated, explicit human-approval architecture exists in the project, but **the recording keeps governed action writes disabled**, so do not demonstrate or claim mutation in the read-only recording.

**Limits:** Local demonstration; synthetic seed data; explicit operator-provided AWS credentials; no production identity or public SaaS endpoint. Additional staging/AgentCore architecture is documented separately and is not interchangeable with a verified public deployment.

## 5. Recording structure (target: 2 minutes 45 seconds)

| Time      | Shot                                                                               |
| --------- | ---------------------------------------------------------------------------------- |
| 0:00–0:20 | ClientOps Command, Acme Labs and business problem                                  |
| 0:20–0:50 | Real Bedrock/Strands agent prompt and one intentional invocation                   |
| 0:50–1:23 | Grounded executive briefing with AT RISK status                                    |
| 1:23–1:58 | Expanded evidence and five successful MCP business tools                           |
| 1:58–2:26 | Compact Bedrock/Strands/MCP/PostgreSQL architecture and human authority separation |
| 2:26–2:45 | Benefits and limitations; close                                                    |

Follow the [safe recording runbook](DEMO.md). One real browser inference previously succeeded; each **new** billable Bedrock execution requires the operator's deliberate authorization. Do not repeatedly run a model merely to match wording from prior results.

## 6. Current release checkpoint

Original-source release hardening (PR #18) and fresh browser
reproducibility (PR #19) are merged and certified.

The isolated submission repository was created as a private, history-free
source snapshot with Apache-2.0 licensing and third-party attribution.
On October 22, 2026, [Validate](https://github.com/gabemart2020-collab/clientops-command-hackathon-2026/actions/runs/39814525827) and
[Gate 3B Fresh Demo Reproduction](https://github.com/gabemart2020-collab/clientops-command-hackathon-2026/actions/runs/39814525695) both succeeded on their
first attempts against root commit `e4c041f501f948c5e6e61919e85fe1de2724b89c`.
The remaining gates are owner publication approval, signed-out reviewer
access verification, and final Devpost submission.

## 7. Scope of this preparation

This repository may also contain active staging security/deployment plans. This documentation does **not** authorize AWS reads, model invocations, database migrations or writes, code modifications, deployments, changes to GitHub visibility, reviewer invitations, PR merging, or publishing a Devpost submission.
