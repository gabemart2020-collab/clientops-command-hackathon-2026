-- Phase 4.3 ClientOps Controlled Task Execution Schema Migration
-- Extends the tasks table with durable business fields (description, priority, source_action_proposal_id)
-- and enforces terminal execution record shape on action_executions.

-- 1. Additive columns on tasks table
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS source_action_proposal_id UUID;

-- 2. Constraints on tasks
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_tasks_priority'
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT chk_tasks_priority
            CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_tasks_source_action_proposal'
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT uq_tasks_source_action_proposal
            UNIQUE (source_action_proposal_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_source_proposal_org'
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT fk_tasks_source_proposal_org
            FOREIGN KEY (source_action_proposal_id, organization_id)
            REFERENCES action_proposals(id, organization_id) ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_org_source_proposal
    ON tasks(organization_id, source_action_proposal_id);

-- 3. Invariant: Enforce terminal record shape on action_executions
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_execution_terminal_shape'
    ) THEN
        ALTER TABLE action_executions ADD CONSTRAINT chk_execution_terminal_shape CHECK (
            (status = 'EXECUTING' AND completed_at IS NULL AND error_code IS NULL AND failure_summary IS NULL AND target_entity_id IS NULL)
            OR
            (status = 'COMPLETED' AND target_entity_id IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL AND failure_summary IS NULL)
            OR
            (status = 'FAILED' AND completed_at IS NOT NULL AND error_code IS NOT NULL AND failure_summary IS NOT NULL)
        );
    END IF;
END $$;
