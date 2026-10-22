-- Phase 4 ClientOps Controlled Action Approval Schema Migration (Hardened Phase 4.1.1)
-- Establishes durable tenant-isolated tables for action proposals, human approvals,
-- action executions (idempotency boundary), and append-only audit events.

-- 0. Ensure unique constraint on users(id, organization_id) for composite foreign keys
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_users_id_org'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT uq_users_id_org UNIQUE (id, organization_id);
    END IF;
END $$;

-- 1. Action Proposals Table
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

-- Trigger: Enforce Action Proposals Frozen Fields & Legal State Transitions
CREATE OR REPLACE FUNCTION enforce_action_proposal_immutability_and_transitions()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Check frozen fields are strictly unchanged
    IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Field "id" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Field "organization_id" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.action_type IS DISTINCT FROM NEW.action_type THEN
        RAISE EXCEPTION 'Field "action_type" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.action_class IS DISTINCT FROM NEW.action_class THEN
        RAISE EXCEPTION 'Field "action_class" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.parameters IS DISTINCT FROM NEW.parameters THEN
        RAISE EXCEPTION 'Field "parameters" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.parameter_hash IS DISTINCT FROM NEW.parameter_hash THEN
        RAISE EXCEPTION 'Field "parameter_hash" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.approval_binding_hash IS DISTINCT FROM NEW.approval_binding_hash THEN
        RAISE EXCEPTION 'Field "approval_binding_hash" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
        RAISE EXCEPTION 'Field "correlation_id" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.evidence IS DISTINCT FROM NEW.evidence THEN
        RAISE EXCEPTION 'Field "evidence" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.preconditions IS DISTINCT FROM NEW.preconditions THEN
        RAISE EXCEPTION 'Field "preconditions" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.justification IS DISTINCT FROM NEW.justification THEN
        RAISE EXCEPTION 'Field "justification" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'Field "created_at" on action_proposals is frozen and immutable.';
    END IF;
    IF OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
        RAISE EXCEPTION 'Field "expires_at" on action_proposals is frozen and immutable.';
    END IF;

    -- 2. Enforce legal state transitions on status update
    IF OLD.status = NEW.status THEN
        RAISE EXCEPTION 'Illegal state transition: status is already % on action_proposals.', OLD.status;
    ELSIF OLD.status = 'PROPOSED' AND NEW.status NOT IN ('PENDING_APPROVAL', 'EXPIRED') THEN
        RAISE EXCEPTION 'Illegal state transition from % to % on action_proposals.', OLD.status, NEW.status;
    ELSIF OLD.status = 'PENDING_APPROVAL' AND NEW.status NOT IN ('APPROVED', 'DENIED', 'EXPIRED') THEN
        RAISE EXCEPTION 'Illegal state transition from % to % on action_proposals.', OLD.status, NEW.status;
    ELSIF OLD.status = 'APPROVED' AND NEW.status NOT IN ('EXECUTING', 'EXPIRED') THEN
        RAISE EXCEPTION 'Illegal state transition from % to % on action_proposals.', OLD.status, NEW.status;
    ELSIF OLD.status = 'EXECUTING' AND NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'Illegal state transition from % to % on action_proposals.', OLD.status, NEW.status;
    ELSIF OLD.status IN ('DENIED', 'EXPIRED', 'COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'Cannot transition from terminal state % on action_proposals.', OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_proposals_freeze ON action_proposals;
CREATE TRIGGER trg_action_proposals_freeze
BEFORE UPDATE ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION enforce_action_proposal_immutability_and_transitions();

-- Trigger: Prohibit DELETE on action_proposals
CREATE OR REPLACE FUNCTION prevent_action_proposals_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Action proposals cannot be deleted. DELETE operations are strictly prohibited on table action_proposals.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_proposals_no_delete ON action_proposals;
CREATE TRIGGER trg_action_proposals_no_delete
BEFORE DELETE ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION prevent_action_proposals_delete();

-- Trigger: Enforce Initial Proposal Status strictly 'PROPOSED' on INSERT
CREATE OR REPLACE FUNCTION enforce_action_proposal_initial_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM 'PROPOSED' THEN
        RAISE EXCEPTION 'Action proposals must be created with initial status "PROPOSED". Attempted to insert status "%".', NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_proposals_initial_status ON action_proposals;
CREATE TRIGGER trg_action_proposals_initial_status
BEFORE INSERT ON action_proposals
FOR EACH ROW
EXECUTE FUNCTION enforce_action_proposal_initial_state();

-- 2. Action Approvals Table (Human Decision Persistence)
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

-- Trigger: Validate approval insertion against proposal state, expiration, and authoritative user role
CREATE OR REPLACE FUNCTION validate_action_approval_insertion()
RETURNS TRIGGER AS $$
DECLARE
    v_proposal RECORD;
    v_user RECORD;
BEGIN
    -- 1. Load proposal in same tenant
    SELECT * INTO v_proposal
    FROM action_proposals
    WHERE id = NEW.action_proposal_id AND organization_id = NEW.organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Action proposal % not found in organization %', NEW.action_proposal_id, NEW.organization_id;
    END IF;

    -- 2. Verify proposal status is strictly PENDING_APPROVAL
    IF v_proposal.status != 'PENDING_APPROVAL' THEN
        RAISE EXCEPTION 'Cannot approve proposal %: status is %, expected PENDING_APPROVAL', NEW.action_proposal_id, v_proposal.status;
    END IF;

    -- 3. Verify proposal has not expired at decision time: decided_at <= proposal.expires_at
    IF NEW.decided_at > v_proposal.expires_at THEN
        RAISE EXCEPTION 'Cannot approve expired proposal %: decided_at (%) is after proposal expires_at (%)', NEW.action_proposal_id, NEW.decided_at, v_proposal.expires_at;
    END IF;

    -- 4. Verify valid_until interval: valid_until > decided_at AND valid_until <= proposal.expires_at
    IF NEW.valid_until <= NEW.decided_at THEN
        RAISE EXCEPTION 'Approval valid_until (%) must be strictly after decided_at (%)', NEW.valid_until, NEW.decided_at;
    END IF;

    IF NEW.valid_until > v_proposal.expires_at THEN
        RAISE EXCEPTION 'Approval valid_until (%) cannot exceed proposal expires_at (%)', NEW.valid_until, v_proposal.expires_at;
    END IF;

    -- 5. Null-safe hash equality verification
    IF NEW.approval_binding_hash IS DISTINCT FROM v_proposal.approval_binding_hash THEN
        RAISE EXCEPTION 'Approval binding hash mismatch for proposal %', NEW.action_proposal_id;
    END IF;

    IF NEW.parameter_hash IS DISTINCT FROM v_proposal.parameter_hash THEN
        RAISE EXCEPTION 'Approval parameter hash mismatch for proposal %', NEW.action_proposal_id;
    END IF;

    -- 6. Load authoritative user from users(id, organization_id)
    SELECT * INTO v_user
    FROM users
    WHERE id = NEW.actor_id AND organization_id = NEW.organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Actor % not found in organization %', NEW.actor_id, NEW.organization_id;
    END IF;

    -- 7. Authoritative user role must be admin or operator
    IF v_user.role NOT IN ('admin', 'operator') THEN
        RAISE EXCEPTION 'Actor % has role %, which is not authorized to approve actions (requires admin or operator)', NEW.actor_id, v_user.role;
    END IF;

    -- 8. Snapshot actor_role must match authoritative users.role exactly
    IF NEW.actor_role IS DISTINCT FROM v_user.role THEN
        RAISE EXCEPTION 'Actor role mismatch: approval specifies actor_role % but authoritative user % has role %', NEW.actor_role, NEW.actor_id, v_user.role;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_approvals_validate ON action_approvals;
CREATE TRIGGER trg_action_approvals_validate
BEFORE INSERT ON action_approvals
FOR EACH ROW
EXECUTE FUNCTION validate_action_approval_insertion();

-- Trigger: DB-level immutability for action_approvals (reject UPDATE and DELETE)
CREATE OR REPLACE FUNCTION prevent_action_approvals_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Approval records are immutable. UPDATE and DELETE operations are strictly prohibited on table action_approvals.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_approvals_immutable ON action_approvals;
CREATE TRIGGER trg_action_approvals_immutable
BEFORE UPDATE OR DELETE ON action_approvals
FOR EACH ROW
EXECUTE FUNCTION prevent_action_approvals_modification();

-- 3. Action Executions Table (Durable Idempotency Boundary)
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
CREATE OR REPLACE FUNCTION enforce_action_execution_immutability_and_transitions()
RETURNS TRIGGER AS $$
BEGIN
    -- Freeze authorization and creation fields:
    IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Cannot mutate id on action_executions.';
    END IF;
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Cannot mutate organization_id on action_executions.';
    END IF;
    IF OLD.action_proposal_id IS DISTINCT FROM NEW.action_proposal_id THEN
        RAISE EXCEPTION 'Cannot mutate action_proposal_id on action_executions.';
    END IF;
    IF OLD.action_approval_id IS DISTINCT FROM NEW.action_approval_id THEN
        RAISE EXCEPTION 'Cannot mutate action_approval_id on action_executions.';
    END IF;
    IF OLD.executor_principal IS DISTINCT FROM NEW.executor_principal THEN
        RAISE EXCEPTION 'Cannot mutate executor_principal on action_executions.';
    END IF;
    IF OLD.parameter_hash IS DISTINCT FROM NEW.parameter_hash THEN
        RAISE EXCEPTION 'Cannot mutate parameter_hash on action_executions.';
    END IF;
    IF OLD.approval_binding_hash IS DISTINCT FROM NEW.approval_binding_hash THEN
        RAISE EXCEPTION 'Cannot mutate approval_binding_hash on action_executions.';
    END IF;
    IF OLD.started_at IS DISTINCT FROM NEW.started_at THEN
        RAISE EXCEPTION 'Cannot mutate started_at on action_executions.';
    END IF;
    IF OLD.target_entity_type IS DISTINCT FROM NEW.target_entity_type THEN
        RAISE EXCEPTION 'Cannot mutate target_entity_type on action_executions.';
    END IF;

    -- Enforce state machine transitions:
    -- Allowed transitions: EXECUTING -> COMPLETED, EXECUTING -> FAILED
    -- Reject self-transitions
    IF OLD.status = NEW.status THEN
        RAISE EXCEPTION 'Illegal self-transition: execution status is already %', OLD.status;
    END IF;

    IF OLD.status = 'EXECUTING' THEN
        IF NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
            RAISE EXCEPTION 'Cannot transition action_executions from EXECUTING to %', NEW.status;
        END IF;
    ELSIF OLD.status IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'Cannot transition from terminal state % on action_executions.', OLD.status;
    ELSE
        RAISE EXCEPTION 'Unknown execution status transition from % to %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_executions_freeze ON action_executions;
CREATE TRIGGER trg_action_executions_freeze
BEFORE UPDATE ON action_executions
FOR EACH ROW
EXECUTE FUNCTION enforce_action_execution_immutability_and_transitions();

-- Trigger: Prohibit DELETE on action_executions
CREATE OR REPLACE FUNCTION prevent_action_executions_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Action executions cannot be deleted. DELETE operations are strictly prohibited on table action_executions.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_executions_no_delete ON action_executions;
CREATE TRIGGER trg_action_executions_no_delete
BEFORE DELETE ON action_executions
FOR EACH ROW
EXECUTE FUNCTION prevent_action_executions_delete();

-- Trigger: Enforce Initial Execution Status strictly 'EXECUTING' and null terminal fields on INSERT
CREATE OR REPLACE FUNCTION enforce_action_execution_initial_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM 'EXECUTING' THEN
        RAISE EXCEPTION 'Action executions must be created with initial status "EXECUTING". Attempted to insert status "%".', NEW.status;
    END IF;
    IF NEW.target_entity_id IS NOT NULL THEN
        RAISE EXCEPTION 'Field "target_entity_id" must be NULL when reserving action execution.';
    END IF;
    IF NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Field "completed_at" must be NULL when reserving action execution.';
    END IF;
    IF NEW.error_code IS NOT NULL THEN
        RAISE EXCEPTION 'Field "error_code" must be NULL when reserving action execution.';
    END IF;
    IF NEW.failure_summary IS NOT NULL THEN
        RAISE EXCEPTION 'Field "failure_summary" must be NULL when reserving action execution.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_executions_initial_state ON action_executions;
CREATE TRIGGER trg_action_executions_initial_state
BEFORE INSERT ON action_executions
FOR EACH ROW
EXECUTE FUNCTION enforce_action_execution_initial_state();

-- 4. Audit Events Table (Append-Only Audit Trail)
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

-- Trigger: DB-level append-only enforcement for audit_events (reject UPDATE and DELETE)
CREATE OR REPLACE FUNCTION prevent_audit_events_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit records are append-only. UPDATE and DELETE operations are strictly prohibited on table audit_events.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events;
CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_modification();

-- Trigger: Validate critical audit event payload constraints
CREATE OR REPLACE FUNCTION validate_audit_event_insertion()
RETURNS TRIGGER AS $$
BEGIN
    -- For ACTION_APPROVED and ACTION_DENIED, payload->>'actorRole' must be 'admin' or 'operator'
    IF NEW.event_type IN ('ACTION_APPROVED', 'ACTION_DENIED') THEN
        IF NEW.payload->>'actorRole' IS NULL OR NEW.payload->>'actorRole' NOT IN ('admin', 'operator') THEN
            RAISE EXCEPTION 'Audit event % requires actorRole to be admin or operator, got %', NEW.event_type, NEW.payload->>'actorRole';
        END IF;
    END IF;

    -- Basic check that payload is a json object
    IF jsonb_typeof(NEW.payload) != 'object' THEN
        RAISE EXCEPTION 'Audit event payload must be a JSON object.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_validate ON audit_events;
CREATE TRIGGER trg_audit_events_validate
BEFORE INSERT ON audit_events
FOR EACH ROW
EXECUTE FUNCTION validate_audit_event_insertion();
