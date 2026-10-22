# Data ownership and persistence

**Architectural decision:** PostgreSQL / Supabase owns durable business state. Model-generated text and transient process memory are not authoritative state. Phase 2 defines a Supabase/PostgreSQL-compatible schema executed against a local PostgreSQL 16 development backend container.

## Implemented schema (Phase 2)

Phase 2 implements the additive Supabase/PostgreSQL-compatible schema under `supabase/migrations/20260929120000_phase2_clientops_schema.sql` covering 10 core entities:

1. **`organizations`**: Multi-tenant isolation boundary (`id`, `name`, `slug`, `created_at`, `updated_at`).
2. **`users`**: Tenant operators and leads (`id`, `organization_id`, `email`, `name`, `role`).
3. **`clients`**: Client accounts (`id`, `organization_id`, `name`, `slug`, `industry`, `tier`).
4. **`projects`**: Scoped client engagements (`id`, `organization_id`, `client_id`, `name`, `status`, `lead_user_id`, `target_completion_at`).
5. **`milestones`**: Key project delivery targets (`id`, `organization_id`, `project_id`, `title`, `status`, `due_at`, `completed_at`).
6. **`tasks`**: Operational work items (`id`, `organization_id`, `project_id`, `milestone_id`, `title`, `status`, `assignee_user_id`, `due_at`, `completed_at`).
7. **`meetings`**: Scheduled and completed briefings (`id`, `organization_id`, `client_id`, `project_id`, `title`, `scheduled_at`, `status`, `summary`).
8. **`communications`**: Inquiries, emails, and notes (`id`, `organization_id`, `client_id`, `channel`, `subject`, `summary`, `occurred_at`, `requires_response`, `resolved_at`).
9. **`commitments`**: Explicit customer commitments (`id`, `organization_id`, `client_id`, `project_id`, `description`, `owner_user_id`, `due_at`, `status`, `fulfilled_at`, `originating_evidence_type`, `originating_evidence_id`).
10. **`decisions`**: Recorded stakeholder decisions (`id`, `organization_id`, `client_id`, `project_id`, `title`, `rationale`, `decided_at`, `decided_by_user_id`).

### Invariants:

- All tenant-scoped entities contain standard UUIDs (`RFC 4122 v4`), foreign key references, and timestamps (`created_at`, `updated_at`).
- Explicit foreign keys with `ON DELETE CASCADE` or `RESTRICT`.
- B-tree indexes on tenant columns (`organization_id`, `client_id`, `project_id`).

## Tenant isolation enforcement

1. **Server-Side Context:** `TenantContext` (`{ organizationId: string }`) is strictly required by all repository methods in `packages/domain` and `packages/data`.
2. **SQL Scoping:** Every SQL query explicitly scopes to `organization_id = $1`.
3. **Cross-Tenant Verification:** Tests in `packages/data/src/data.test.ts` and `tests/hero.test.ts` verify that tenant A cannot query records from tenant B even when requesting valid IDs or duplicate client names.

## Local database safety

`packages/data/src/db/pool.ts` enforces the configured database target policy. Local mode preserves the loopback/container allowlist and safe local database-name checks. Phase 5.1 staging mode is separately fail-closed: it requires `CLIENTOPS_DATABASE_TARGET=staging`, `CLIENTOPS_ENVIRONMENT=staging`, `CLIENTOPS_DATABASE_WORKLOAD=mcp`, an exact configured non-local host/database/user, TLS, and the MCP reader privilege preflight. Production/customer targets remain prohibited.

## Implemented additive persistence schema (Phase 4.1)

Phase 4.1 implements the additive PostgreSQL / Supabase-compatible schema under `supabase/migrations/20261005120000_phase4_controlled_action_approval.sql` to persist action proposals, human approvals, action execution records, and append-only audit events:

### 1. `action_proposals`

Stores server-owned proposals emitted by the agent or operator. Authorization-critical fields are frozen at insertion time via database trigger:

```sql
CREATE TABLE IF NOT EXISTS action_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    action_type TEXT NOT NULL,
    action_class TEXT NOT NULL,
    parameters JSONB NOT NULL,
    parameter_hash TEXT NOT NULL,
    approval_binding_hash TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    evidence JSONB NOT NULL,
    preconditions JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    justification TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_proposal_status CHECK (status IN ('PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'DENIED', 'EXPIRED', 'EXECUTING', 'COMPLETED', 'FAILED')),
    CONSTRAINT chk_proposal_action_type CHECK (action_type = 'task.create'),
    CONSTRAINT chk_proposal_action_class CHECK (action_class = 'WRITE'),
    CONSTRAINT chk_proposal_parameter_hash CHECK (parameter_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_proposal_approval_binding_hash CHECK (approval_binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_proposal_evidence_not_empty CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
    CONSTRAINT chk_proposal_preconditions_not_empty CHECK (jsonb_typeof(preconditions) = 'array' AND jsonb_array_length(preconditions) >= 1),
    CONSTRAINT uq_action_proposals_id_org UNIQUE (id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_org_status ON action_proposals(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_org_expires ON action_proposals(organization_id, expires_at);

-- Trigger: Enforce frozen field immutability and legal state transitions
CREATE TRIGGER trg_action_proposals_freeze
BEFORE UPDATE ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION enforce_action_proposal_immutability_and_transitions();

-- Trigger: Prevent deletion of action proposals
CREATE TRIGGER trg_action_proposals_no_delete
BEFORE DELETE ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION prevent_action_proposals_delete();

-- Trigger: Enforce initial status 'PROPOSED' on INSERT
CREATE TRIGGER trg_action_proposals_initial_status
BEFORE INSERT ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION enforce_action_proposal_initial_state();
```

### 2. `action_approvals`

Stores durable human approval decisions bound to actor, tenant, exact parameters, validity period, and approval binding hash. Immutability trigger strictly prohibits UPDATE and DELETE, and validation trigger enforces tenant and status rules:

```sql
CREATE TABLE IF NOT EXISTS action_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    action_proposal_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    actor_role TEXT NOT NULL,
    decision TEXT NOT NULL,
    parameter_hash TEXT NOT NULL,
    approval_binding_hash TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ NOT NULL,
    comment TEXT,
    CONSTRAINT chk_approval_decision CHECK (decision IN ('APPROVE', 'DENY')),
    CONSTRAINT chk_approval_actor_role CHECK (actor_role IN ('admin', 'operator')),
    CONSTRAINT chk_approval_parameter_hash CHECK (parameter_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_approval_binding_hash CHECK (approval_binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT uq_action_approvals_proposal UNIQUE (action_proposal_id),
    CONSTRAINT uq_action_approvals_id_org UNIQUE (id, organization_id),
    CONSTRAINT uq_action_approvals_id_proposal_org UNIQUE (id, action_proposal_id, organization_id),
    CONSTRAINT fk_action_approvals_proposal_org FOREIGN KEY (action_proposal_id, organization_id)
        REFERENCES action_proposals(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_action_approvals_actor_org FOREIGN KEY (actor_id, organization_id)
        REFERENCES users(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_approvals_org ON action_approvals(organization_id);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON action_approvals(action_proposal_id);

-- Trigger: Prohibit UPDATE and DELETE
CREATE TRIGGER trg_action_approvals_immutable
BEFORE UPDATE OR DELETE ON action_approvals
FOR EACH ROW
EXECUTE FUNCTION prevent_action_approvals_modification();

-- Trigger: Validate proposal state and hash equality before approval insert
CREATE TRIGGER trg_action_approvals_validate
BEFORE INSERT ON action_approvals
FOR EACH ROW
EXECUTE FUNCTION validate_action_approval_insertion();
```

### 3. `action_executions`

Guarantees **hard idempotency** and exactly-once execution boundary. Execution is strictly bound to the exact approval via composite foreign key, and records the server-owned executor identity:

```sql
CREATE TABLE IF NOT EXISTS action_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    action_proposal_id UUID NOT NULL,
    action_approval_id UUID NOT NULL,
    executor_principal TEXT NOT NULL DEFAULT 'clientops_trusted_executor',
    status TEXT NOT NULL DEFAULT 'EXECUTING',
    target_entity_type TEXT NOT NULL DEFAULT 'task',
    target_entity_id UUID,
    parameter_hash TEXT NOT NULL,
    approval_binding_hash TEXT NOT NULL,
    error_code TEXT,
    failure_summary TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT chk_execution_status CHECK (status IN ('EXECUTING', 'COMPLETED', 'FAILED')),
    CONSTRAINT chk_execution_principal CHECK (executor_principal = 'clientops_trusted_executor'),
    CONSTRAINT chk_execution_parameter_hash CHECK (parameter_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_execution_approval_binding_hash CHECK (approval_binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_execution_error_code CHECK (error_code IS NULL OR length(error_code) <= 100),
    CONSTRAINT chk_execution_failure_summary CHECK (failure_summary IS NULL OR length(failure_summary) <= 500),
    CONSTRAINT uq_action_executions_proposal UNIQUE (action_proposal_id),
    CONSTRAINT uq_action_executions_id_org UNIQUE (id, organization_id),
    CONSTRAINT fk_action_executions_approval_proposal_org FOREIGN KEY (action_approval_id, action_proposal_id, organization_id)
        REFERENCES action_approvals(id, action_proposal_id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_executions_org_status ON action_executions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_executions_proposal ON action_executions(action_proposal_id);

-- Trigger: Freeze execution authorization fields and enforce state transitions
CREATE TRIGGER trg_action_executions_freeze
BEFORE UPDATE ON action_executions
FOR EACH ROW
EXECUTE FUNCTION enforce_action_execution_immutability_and_transitions();

-- Trigger: Prevent deletion of action executions
CREATE TRIGGER trg_action_executions_no_delete
BEFORE DELETE ON action_executions
FOR EACH ROW
EXECUTE FUNCTION prevent_action_executions_delete();

-- Trigger: Enforce initial status 'EXECUTING' and null terminal fields on INSERT
CREATE TRIGGER trg_action_executions_initial_state
BEFORE INSERT ON action_executions
FOR EACH ROW
EXECUTE FUNCTION enforce_action_execution_initial_state();
```

### 4. `audit_events`

Stores append-only audit events with database-level immutability enforcement and strict allowlisted schemas:

```sql
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    action_proposal_id UUID,
    event_type TEXT NOT NULL,
    actor_id UUID,
    parameter_hash TEXT,
    approval_binding_hash TEXT,
    correlation_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_audit_event_type CHECK (event_type IN (
        'ACTION_PROPOSED',
        'APPROVAL_REQUESTED',
        'ACTION_APPROVED',
        'ACTION_DENIED',
        'ACTION_EXPIRED',
        'EXECUTION_STARTED',
        'EXECUTION_COMPLETED',
        'EXECUTION_FAILED'
    )),
    CONSTRAINT chk_audit_parameter_hash CHECK (parameter_hash IS NULL OR parameter_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_audit_approval_binding_hash CHECK (approval_binding_hash IS NULL OR approval_binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT fk_audit_events_proposal_org FOREIGN KEY (action_proposal_id, organization_id)
        REFERENCES action_proposals(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_audit_events_actor_org FOREIGN KEY (actor_id, organization_id)
        REFERENCES users(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_audit_org_occurred ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_proposal ON audit_events(action_proposal_id);

-- DB-Level Enforcement: Prohibit UPDATE and DELETE on audit_events
CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_modification();

-- DB-Level Enforcement: Validate audit event payloads and authorizer roles on INSERT
CREATE TRIGGER trg_audit_events_validate
BEFORE INSERT ON audit_events
FOR EACH ROW
EXECUTE FUNCTION validate_audit_event_insertion();
```

## Composite foreign key multi-tenant and actor isolation

To eliminate any possibility of cross-tenant or cross-proposal foreign key linkages:

1. `users` defines `CONSTRAINT uq_users_id_org UNIQUE (id, organization_id)`.
2. `action_approvals` enforces:
   - `FOREIGN KEY (action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)`
   - `FOREIGN KEY (actor_id, organization_id) REFERENCES users(id, organization_id)`
     This physically blocks any approval from referencing a user in another organization or a proposal in another organization.
3. `action_executions` enforces:
   - `FOREIGN KEY (action_approval_id, action_proposal_id, organization_id) REFERENCES action_approvals(id, action_proposal_id, organization_id)`
     The authoritative execution-to-proposal chain is enforced through this composite foreign key combined with `action_approvals`' composite foreign key `(action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)`. This guarantees that an execution cannot be inserted without a valid approval, cannot link to an approval for a different proposal, and cannot link to an approval from another tenant.
4. `audit_events` enforces:
   - `FOREIGN KEY (action_proposal_id, organization_id) REFERENCES action_proposals(id, organization_id)`
   - `FOREIGN KEY (actor_id, organization_id) REFERENCES users(id, organization_id)`
     This physically blocks audit events from referencing proposals or users belonging to another tenant.
5. `ON DELETE RESTRICT` is enforced across all relationships, combined with database-level triggers rejecting `DELETE` on `action_proposals`, `action_approvals`, `action_executions`, and `audit_events`.

## Execution failure & reconnect reconciliation semantics

Authoritative action execution executes inside a single PostgreSQL transaction owned by the mutation executor:

1. `SELECT proposal FOR UPDATE`
2. Load and verify approval (`APPROVED`, valid actor, valid binding hash, unexpired)
3. Re-verify preconditions (`updated_at` timestamps)
4. Check execution idempotency
5. Insert `action_executions` row (`status = 'EXECUTING'`)
6. Execute business mutation (e.g. `INSERT INTO tasks`)

### Infrastructure failure vs. catchable domain errors:

1. **Infrastructure Failure & Transaction Abort (Connection Loss / Crash):**
   - If an unrecoverable database or infrastructure error occurs, the single transaction rolls back entirely (`ROLLBACK;`).
   - Because the transaction rolls back, the durable database state of the proposal remains in its prior committed state: `APPROVED`.
   - The system does **NOT** manufacture an illegal `APPROVED -> FAILED` transition (the frozen state machine strictly forbids it: `APPROVED` may only transition to `EXECUTING` or `EXPIRED`).
   - **Reconnect Reconciliation:** Upon reconnection, the system reconciles via the approved proposal ID (`proposalId`). Querying `action_executions` by `action_proposal_id` determines whether an execution record was committed. If no execution row exists, execution can be retried safely.
2. **Domain Mutation Failure (Catchable Error with SAVEPOINT):**
   - The executor wraps the business mutation step in `SAVEPOINT task_mutation;`.
   - If a catchable domain error occurs (e.g. validation failure during task creation), the executor issues `ROLLBACK TO SAVEPOINT task_mutation;`.
   - The surrounding transaction remains valid. The executor updates `action_executions` with `status = 'FAILED'` and sanitized `failure_summary` (<= 500 characters, no raw errors, no stack traces), transitions the proposal from `EXECUTING` to `FAILED`, appends an `EXECUTION_FAILED` audit event, and calls `COMMIT;`.

## Implemented additive persistence schema (Phase 4.3)

Phase 4.3 implements additive schema updates under `supabase/migrations/20261008120000_phase4_controlled_task_execution.sql` supporting controlled execution of approved `task.create` proposals:

### 1. `tasks` table extensions

The `tasks` table is extended to persist optional task description, explicit task priority, and durable source proposal lineage:

```sql
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS source_action_proposal_id UUID;

ALTER TABLE tasks
    ADD CONSTRAINT chk_tasks_priority
    CHECK (priority IN ('low', 'medium', 'high', 'urgent'));

ALTER TABLE tasks
    ADD CONSTRAINT uq_tasks_source_action_proposal
    UNIQUE (source_action_proposal_id);

ALTER TABLE tasks
    ADD CONSTRAINT fk_tasks_source_proposal_org
    FOREIGN KEY (source_action_proposal_id, organization_id)
    REFERENCES action_proposals(id, organization_id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_org_source_proposal
    ON tasks(organization_id, source_action_proposal_id);
```

### 2. Dual durable idempotency barriers

Execution idempotency is enforced by two database-level barriers:

1. `uq_action_executions_proposal`: `UNIQUE (action_proposal_id)` on `action_executions` ensures that at most one execution reservation exists per proposal.
2. `uq_tasks_source_action_proposal`: `UNIQUE (source_action_proposal_id)` on `tasks` ensures that at most one business task can ever be created for a given action proposal.
3. Composite tenant foreign key `fk_tasks_source_proposal_org` guarantees tenant consistency between the task and its source action proposal.

### 3. Execution terminal shape check constraint

The `action_executions` table enforces consistent terminal state shapes at the database engine level:

```sql
ALTER TABLE action_executions
    ADD CONSTRAINT chk_execution_terminal_shape
    CHECK (
        (status = 'EXECUTING' AND completed_at IS NULL AND error_code IS NULL AND failure_summary IS NULL AND target_entity_id IS NULL)
        OR
        (status = 'COMPLETED' AND target_entity_id IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL AND failure_summary IS NULL)
        OR
        (status = 'FAILED' AND completed_at IS NOT NULL AND error_code IS NOT NULL AND failure_summary IS NOT NULL)
    );
```

### 4. Due-date temporal serialization & canonicalization invariant (Phase 4.3.3)

In Phase 4.3, task due dates are persisted in PostgreSQL under `tasks.due_at` as `TIMESTAMPTZ`.

1. **Pre-Persistence Canonicalization:** Model-suggested ISO datetime strings in `dueAt` (which may omit milliseconds, e.g. `2026-10-16T09:00:00Z` -> `2026-10-16T09:00:00.000Z`, or supply fractional milliseconds, e.g. `2026-10-16T09:00:00.123Z`) are canonicalized server-side to canonical UTC ISO-8601 at JavaScript millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`) during `materializeTaskCreateParameters` via `canonicalizeIsoDateTime`. This canonical representation is used for `parameterHash` computation, `approvalBindingHash` derivation, proposal persistence, and human operator approval binding.
2. **Temporal Instant Readback Verification:** When `executeApprovedAction` verifies the created task row read back from PostgreSQL, `sameOptionalInstant` compares timestamps by temporal epoch milliseconds (`Date.getTime()`). The system deliberately freezes `dueAt` at JavaScript millisecond precision prior to hashing and approval. This guarantees that string serialization variations (e.g., presence or absence of millisecond components) do not cause false-negative validation failures, while genuine timestamp discrepancies (detecting a 1 millisecond difference) fail closed and trigger savepoint rollback.

## Phase 5 cloud data boundary

### Phase 5.0 (Completed / merged)

Phase 5.0 froze four workload identities conceptually: MCP reader, Agent proposer, Web approver, and Trusted executor. AgentCore Memory remains outside the authoritative business data model.

### Phase 5.1 MCP reader implementation

Phase 5.1 changes no ClientOps table schema and adds no normal migration. Instead it adds deployment/safety artifacts outside `supabase/migrations/`:

- `supabase/staging/001_clientops_mcp_reader.sql` — creates the NOLOGIN staging reader group role, grants SELECT only on the ten MCP business tables, and revokes control-plane table access.
- `supabase/staging/002_clientops_demo_seed.sql` — idempotent synthetic certification data using `INSERT ... ON CONFLICT DO NOTHING`; contains no TRUNCATE/DELETE/DROP path.
- `packages/data/src/db/target-policy.ts` — explicit local/staging target validation.
- `packages/data/src/db/staging-preflight.ts` — runtime privilege certification before the staging MCP listener starts.

Phase 5.1 staging connections additionally require `CLIENTOPS_DATABASE_WORKLOAD=mcp`. The staging MCP credential must be a separate non-elevated LOGIN role with exactly one direct `clientops_mcp_reader` membership and no additional direct role memberships. It is not an owner/superuser and receives no proposal, approval, execution, audit, or task-mutation authority.

Remote schema application remains additive. Local reset/seed commands are unchanged and remain local-only. Production/customer database targets are outside Phase 5.1.

The other frozen workload identities (Agent proposer, Web approver, Trusted executor) are not provisioned or changed in Phase 5.1.

See ADR 0006, `docs/PHASE5_CONTRACTS.md`, and `docs/PHASE5_1_RUNBOOK.md`.
