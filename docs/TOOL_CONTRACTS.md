# Tool contracts

Shared boundary contracts are defined using Zod under `packages/contracts`. All tool definitions use strict Zod schemas without `any` or loose objects.

## Implemented tools (Phase 1 & 2)

| Tool Name                        | Action Class | Input Schema                            | Output Schema                | Description                                                                                                                                               |
| -------------------------------- | ------------ | --------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system.get_status`              | READ         | `{}`                                    | `StatusOutput`               | Transport health and protocol baseline check.                                                                                                             |
| `account.get_context`            | READ         | `{ account_ref: string }`               | `GetAccountContextOutput`    | Resolves account identity, active projects, upcoming meetings, open commitments, and metric counts.                                                       |
| `activity.get_recent`            | READ         | `{ client_id: string, limit?: number }` | `RecentActivityOutput`       | Retrieves chronological timeline of tasks, meetings, communications, and decisions.                                                                       |
| `commitment.list_open`           | READ         | `{ client_id: string }`                 | `ListOpenCommitmentsOutput`  | Lists open commitments for an account, excluding fulfilled or cancelled items.                                                                            |
| `project.assess_delivery_health` | ANALYZE      | `{ project_id: string }`                | `AssessDeliveryHealthOutput` | Deterministically calculates delivery health (`on_track`, `watch`, `at_risk`), identifying overdue milestones, overdue tasks, and unresolved inquiries.   |
| `meeting.prepare_brief`          | ANALYZE      | `{ meeting_id: string }`                | `PrepareBriefOutput`         | Composes briefing pack for an upcoming meeting: client identity, project health, open commitments, recent activity, factual talking points, and evidence. |

## Action classification

- **READ**: Retrieves authorized domain state; no business mutation or side-effects. Automatically allowed.
- **ANALYZE**: Deterministically evaluates domain facts (e.g. delivery health rules) and derives evidence-backed conclusions; no side-effects. Automatically allowed.
- **DRAFT**: Synthesizes internal text content (e.g. client update drafts) with no external side-effects and no dispatch capability. Automatically allowed.
- **WRITE**: Mutates business records (Phase 4). Strictly requires deterministic server-side human approval bound to verified actor identity, exact parameters, validity period, and record versions. Fails closed without valid approval.
- **EXTERNAL & DESTRUCTIVE**: Strictly out of scope for v1 and denied by policy.

## Phase 4 Vertical Slice: Trusted Server Execution of `task.create` (Phase 4.3 Implemented)

> [!IMPORTANT]
> The MCP tool catalog remains strictly 100% READ and ANALYZE tools (`system.get_status`, `account.get_context`, `activity.get_recent`, `commitment.list_open`, `project.assess_delivery_health`, `meeting.prepare_brief`). Zero WRITE tools are exposed to or discoverable by the model or MCP clients.
>
> Task execution is implemented strictly as a trusted server-side service (`executeApprovedAction` in `packages/policy`), invoked from the trusted application boundary after a verified human approval decision. Production authentication / identity-provider integration is not yet implemented; the current local demo actor is dev/test-only.

### Execution Service Specification (Implemented in Phase 4.3)

| Component               | Action Class | Input Interface             | Output Interface              | Description                                                                                                                  |
| ----------------------- | ------------ | --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `executeApprovedAction` | WRITE        | `{ proposalId: UUID, ... }` | `ExecuteApprovedActionResult` | Executes an approved task creation proposal inside ONE PostgreSQL transaction. All parameters reloaded from durable storage. |

### Architectural Invariant: `{ proposalId }` Only

When invoking the trusted server executor for an approved action, the caller supplies `{ proposalId }` (along with tenant context, repositories, and transaction runner) only:

- **Zero tampering surface:** No caller-submitted mutation parameters are accepted at execution time.
- **Frozen parameters:** The executor loads the immutable `ActionProposal` directly from durable storage within the verified tenant context.
- **Double verification:** The executor recomputes both `computeCanonicalParameterHash` and `computeApprovalBindingHash({ organizationId, actionType, parameters, preconditions, expiresAt })` and confirms equality against both the proposal and approval records.
- **Single Transaction Execution:** Execution verification, idempotency checking, state transition, task insertion, read-back verification, and audit event emission occur inside a single PostgreSQL transaction owned by the mutating component (`SELECT ... FOR UPDATE`, verify approval, check `updated_at` preconditions against locked rows, insert execution record, insert task, verify task, append audit events, commit).
- **Dual Idempotency:** Database unique constraints `UNIQUE(action_executions.action_proposal_id)` and `UNIQUE(tasks.source_action_proposal_id)` prevent duplicate execution or task creation.

### Human Approval Application Boundary (Implemented in Phase 4.2 & 4.3)

Approval resolution is NEVER an MCP tool. Neither `action.approve` nor `action.deny` will ever exist as an MCP tool. Human approval occurs exclusively through a trusted application boundary outside MCP (ADR 0003, ADR 0005). Production authentication is a planned control, not a Phase 4 claim:

- **Approval Decision Contract:** `POST /api/actions/[proposalId]/decision`
  - Input Schema: `ApprovalDecisionRequestSchema = { decision: 'APPROVE' | 'DENY', comment?: string (max 500) }`
  - Output Contract:
    - On `DENY`: `{ success: true, data: { proposalId, status: 'DENIED', decision: 'DENY', decidedAt, idempotent } }`. The server executor is never invoked.
    - On `APPROVE`: Durably records human approval and atomically invokes `executeApprovedAction`. Returns the execution outcome:
      - `COMPLETED`: `{ success: true, data: { proposalId, status: 'COMPLETED', decision: 'APPROVE', decidedAt, idempotent, execution: { status: 'COMPLETED', executionId, completedAt, task: { id, title, status, projectId, priority } } } }`
      - `FAILED`: `{ success: true, data: { proposalId, status: 'FAILED', decision: 'APPROVE', decidedAt, idempotent, execution: { status: 'FAILED', executionId, errorCode, failureSummary } } }`
      - `BLOCKED`: On tampering, unauthorized approver, failed preconditions, invalid status, or integrity conflicts: `{ success: true, data: { proposalId, status, decision: 'APPROVE', decidedAt, idempotent, execution: { status: 'BLOCKED', code, message } } }`
      - `EXPIRED`: On expired approval or proposal validity window: `{ success: true, data: { proposalId, status: 'EXPIRED', decision: 'APPROVE', decidedAt, idempotent, execution: { status: 'EXPIRED', reason, message } } }`
      - `UNCONFIRMED`: On unhandled execution interruption: `{ success: true, data: { proposalId, status: 'APPROVED', decision: 'APPROVE', decidedAt, idempotent, execution: { status: 'UNCONFIRMED', message } } }`
- **Inspection Read Contract:** `GET /api/actions/[proposalId]`
  - Output Schema: Tenant-scoped proposal review detail with client, project, parameters, and evidence. Internal hashes and raw prompts are omitted.
- **Trust Boundary & Authentication:** Approval resolution is a trusted application boundary. Production authentication and identity provider integration are NOT yet implemented; the current local demo actor identity is strictly dev/test-only and fails closed outside that environment (`resolveTrustedActor` rejects non-dev/test environments).

Unknown action types deterministically evaluate to `DENIED` and `EXTERNAL`, never `WRITE` or `REQUIRES_APPROVAL`.

## Evidence references

All material risk findings carry non-null `EvidenceRef` objects:

```ts
type EvidenceRef = {
  entityType:
    | 'client'
    | 'project'
    | 'milestone'
    | 'task'
    | 'meeting'
    | 'communication'
    | 'commitment'
    | 'decision';
  entityId: string; // RFC 4122 v4 UUID
  field?: string;
  excerpt?: string;
};
```

Findings cannot exist without resolving to an authoritative business record.

### Authoritative evidence semantics

Evidence references produced by tools fall into two explicit, deterministic classes:

1. **Direct scalar entity references**: Cites authentic scalar source attributes without transformation:
   - **Task**: `field: 'title'`, `excerpt: task.title` (or `field: 'due_at'`, `excerpt: task.dueAt`).
   - **Meeting**: `field: 'summary'`, `excerpt: meeting.summary` (or `field: 'title'`, `excerpt: meeting.title`).
   - **Decision**: `field: 'rationale'`, `excerpt: decision.rationale` (or `field: 'title'`, `excerpt: decision.title`).
   - **Communication**: `field: 'summary'`, `excerpt: communication.summary` (or `field: 'subject'`, `excerpt: communication.subject`).
   - **Commitment**: `field: 'description'`, `excerpt: commitment.description` (or `field: 'due_at'`, `excerpt: commitment.dueAt`).
   - **Milestone**: `field: 'title'`, `excerpt: milestone.title` (or `field: 'due_at'`, `excerpt: milestone.dueAt`).

2. **Deterministic derived evidence excerpts**: Analytical rule evaluations in `project.assess_delivery_health` and `meeting.prepare_brief` produce contractually specified derived excerpts:
   - **Overdue Milestone**: `field: 'due_at'`, `excerpt: 'Milestone "<title>" due <dueAt> is <daysOverdue> day(s) overdue (status: <status>)'`.
   - **Unresolved Question**: `field: 'requires_response'`, `excerpt: 'Communication "<subject>" on <occurredAt> requires response and is unresolved'`.
   - **Overdue Commitment**: `field: 'due_at'`, `excerpt: 'Commitment "<description>" was due <dueAt>'`.
   - **Overdue Task**: `field: 'due_at'`, `excerpt: 'Task "<title>" was due <dueAt>'`.

Composite text must never be arbitrarily manufactured by the LLM. The LLM emits citations (`{ entityType, entityId, field? }`), and the runtime citation resolver hydrates complete, canonical `EvidenceRef` structures directly from the request-local evidence registry.

## Phase 5 runtime portability invariant

Phase 5.0 changed no tool schema and added no tool. Phase 5.1 preserves that catalog while implementing only the remote MCP/data-plane portability layer.

- Local and future AgentCore MCP runtimes must expose the same MCP 2025-11-25 catalog and semantics.
- AgentCore deployment must not surface `task.create`, approval, denial, or execution as MCP tools.
- Future AgentCore session or memory data is not tool evidence and must never be registered as an `EvidenceRef`.
- Future remote agent invocation returns only sanitized public trace/grounding/proposal metadata; request-local evidence resolvers remain internal to the agent application trust unit.

See ADR 0006, `docs/PHASE5_CONTRACTS.md`, and `docs/PHASE5_1_RUNBOOK.md`. Phase 5.1 is authorized only for the non-production staging/MCP data plane; Phase 5.2+ remains separately gated.
