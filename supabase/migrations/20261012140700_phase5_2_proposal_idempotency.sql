-- Phase 5.2.2 durable proposal request idempotency.
-- A trusted Agent Runtime requestId is persisted as correlation_id.
-- Reject deployment if historical data violates the logical key rather than
-- deleting or merging records automatically.

DO $clientops$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.action_proposals
    GROUP BY organization_id, correlation_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add proposal request idempotency: duplicate (organization_id, correlation_id) rows exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_action_proposals_org_correlation'
      AND conrelid = 'public.action_proposals'::regclass
  ) THEN
    ALTER TABLE public.action_proposals
      ADD CONSTRAINT uq_action_proposals_org_correlation
      UNIQUE (organization_id, correlation_id);
  END IF;
END
$clientops$;
