-- Phase 5.1 staging-only Supabase security hardening.
-- This environment uses direct PostgreSQL only. ClientOps tables must not be
-- reachable by Supabase Data API roles, and trigger functions must not retain
-- the default PUBLIC EXECUTE surface.

REVOKE ALL PRIVILEGES ON TABLE
  organizations,
  users,
  clients,
  projects,
  milestones,
  tasks,
  meetings,
  communications,
  commitments,
  decisions,
  action_proposals,
  action_approvals,
  action_executions,
  audit_events
FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Prevent future public-schema objects created by postgres from silently
-- regaining Data API privileges in this staging project.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC;

-- These are trigger-only functions. Pin search_path and remove direct Data API
-- execution access; table triggers continue to execute in normal PostgreSQL use.
ALTER FUNCTION public.enforce_action_execution_initial_state()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_audit_events_modification()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.validate_audit_event_insertion()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_action_execution_immutability_and_transitions()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_action_proposal_immutability_and_transitions()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_action_proposals_delete()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_action_proposal_initial_state()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.validate_action_approval_insertion()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_action_approvals_modification()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_action_executions_delete()
  SET search_path = pg_catalog, public;

REVOKE EXECUTE ON FUNCTION public.enforce_action_execution_initial_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_audit_events_modification() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_audit_event_insertion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_action_execution_immutability_and_transitions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_action_proposal_immutability_and_transitions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_action_proposals_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_action_proposal_initial_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_action_approval_insertion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_action_approvals_modification() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_action_executions_delete() FROM PUBLIC, anon, authenticated;
