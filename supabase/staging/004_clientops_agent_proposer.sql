-- Phase 5.2.2 staging-only least-privilege Agent Runtime proposer boundary.
-- Apply only to the isolated non-production ClientOps staging database after
-- normal additive schema migrations.
--
-- This file intentionally lives outside supabase/migrations because it creates
-- cluster-level service roles. The LOGIN role is created without a password;
-- the operator must set a securely generated password out-of-band and store the
-- resulting connection URL in the dedicated Secrets Manager secret.

DO $clientops$
DECLARE
  proposer_role RECORD;
  login_role RECORD;
BEGIN
  SELECT
    rolcanlogin,
    rolinherit,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls
  INTO proposer_role
  FROM pg_roles
  WHERE rolname = 'clientops_agent_proposer';

  IF NOT FOUND THEN
    CREATE ROLE clientops_agent_proposer NOLOGIN NOINHERIT;
    SELECT
      rolcanlogin,
      rolinherit,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls
    INTO proposer_role
    FROM pg_roles
    WHERE rolname = 'clientops_agent_proposer';
  END IF;

  IF proposer_role.rolcanlogin
     OR proposer_role.rolsuper
     OR proposer_role.rolcreatedb
     OR proposer_role.rolcreaterole
     OR proposer_role.rolreplication
     OR proposer_role.rolbypassrls THEN
    RAISE EXCEPTION
      'clientops_agent_proposer has elevated or LOGIN attributes; refusing provisioning';
  END IF;

  SELECT
    rolcanlogin,
    rolinherit,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls
  INTO login_role
  FROM pg_roles
  WHERE rolname = 'clientops_agent_staging_login';

  IF NOT FOUND THEN
    CREATE ROLE clientops_agent_staging_login LOGIN INHERIT;
    SELECT
      rolcanlogin,
      rolinherit,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls
    INTO login_role
    FROM pg_roles
    WHERE rolname = 'clientops_agent_staging_login';
  END IF;

  IF NOT login_role.rolcanlogin
     OR NOT login_role.rolinherit
     OR login_role.rolsuper
     OR login_role.rolcreatedb
     OR login_role.rolcreaterole
     OR login_role.rolreplication
     OR login_role.rolbypassrls THEN
    RAISE EXCEPTION
      'clientops_agent_staging_login has unexpected PostgreSQL role attributes; refusing provisioning';
  END IF;
END
$clientops$;

REVOKE CREATE ON SCHEMA public FROM clientops_agent_proposer;
REVOKE CREATE ON SCHEMA public FROM clientops_agent_staging_login;
GRANT USAGE ON SCHEMA public TO clientops_agent_proposer;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM clientops_agent_proposer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM clientops_agent_proposer;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM clientops_agent_staging_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM clientops_agent_staging_login;

GRANT SELECT ON TABLE
  public.clients,
  public.projects,
  public.users,
  public.milestones,
  public.action_proposals
TO clientops_agent_proposer;

GRANT INSERT (
  id,
  organization_id,
  action_type,
  action_class,
  parameters,
  parameter_hash,
  approval_binding_hash,
  correlation_id,
  evidence,
  preconditions,
  status,
  justification,
  created_at,
  expires_at,
  updated_at
) ON public.action_proposals TO clientops_agent_proposer;

GRANT UPDATE (status, updated_at)
ON public.action_proposals TO clientops_agent_proposer;

GRANT INSERT (
  id,
  organization_id,
  action_proposal_id,
  event_type,
  actor_id,
  parameter_hash,
  approval_binding_hash,
  correlation_id,
  payload,
  occurred_at
) ON public.audit_events TO clientops_agent_proposer;

-- No direct privileges on approval/execution/task mutation surfaces.
REVOKE ALL PRIVILEGES ON TABLE
  public.tasks,
  public.action_approvals,
  public.action_executions
FROM clientops_agent_proposer;

CREATE OR REPLACE FUNCTION public.enforce_clientops_agent_proposer_action_proposals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'clientops_agent_proposer', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.action_type IS DISTINCT FROM 'task.create'
       OR NEW.action_class IS DISTINCT FROM 'WRITE'
       OR NEW.status IS DISTINCT FROM 'PROPOSED'
       OR NEW.correlation_id IS NULL
       OR btrim(NEW.correlation_id) = '' THEN
      RAISE EXCEPTION
        'clientops_agent_proposer may insert only non-empty correlated task.create WRITE proposals at PROPOSED';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM 'PROPOSED'
       OR NEW.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION
        'clientops_agent_proposer may transition only PROPOSED -> PENDING_APPROVAL';
    END IF;

    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
       OR OLD.action_type IS DISTINCT FROM NEW.action_type
       OR OLD.action_class IS DISTINCT FROM NEW.action_class
       OR OLD.parameters IS DISTINCT FROM NEW.parameters
       OR OLD.parameter_hash IS DISTINCT FROM NEW.parameter_hash
       OR OLD.approval_binding_hash IS DISTINCT FROM NEW.approval_binding_hash
       OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
       OR OLD.evidence IS DISTINCT FROM NEW.evidence
       OR OLD.preconditions IS DISTINCT FROM NEW.preconditions
       OR OLD.justification IS DISTINCT FROM NEW.justification
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
      RAISE EXCEPTION
        'clientops_agent_proposer attempted to mutate frozen proposal fields';
    END IF;

    -- The application targets updated_at explicitly. Normalize it at the
    -- database boundary so the proposer cannot choose an authority-bearing
    -- historical/future timestamp.
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'clientops_agent_proposer operation % is not permitted on action_proposals',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_clientops_agent_proposer_action_proposals
  ON public.action_proposals;
CREATE TRIGGER trg_clientops_agent_proposer_action_proposals
BEFORE INSERT OR UPDATE ON public.action_proposals
FOR EACH ROW
EXECUTE FUNCTION public.enforce_clientops_agent_proposer_action_proposals();

CREATE OR REPLACE FUNCTION public.enforce_clientops_agent_proposer_audit_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  proposal_row RECORD;
BEGIN
  IF NOT pg_has_role(current_user, 'clientops_agent_proposer', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN ('ACTION_PROPOSED', 'APPROVAL_REQUESTED') THEN
    RAISE EXCEPTION
      'clientops_agent_proposer may append only ACTION_PROPOSED or APPROVAL_REQUESTED';
  END IF;

  IF NEW.actor_id IS NOT NULL
     OR NEW.action_proposal_id IS NULL
     OR NEW.correlation_id IS NULL
     OR btrim(NEW.correlation_id) = '' THEN
    RAISE EXCEPTION
      'clientops_agent_proposer audit events require proposal/correlation identity and no human actor';
  END IF;

  SELECT
    correlation_id,
    parameter_hash,
    approval_binding_hash
  INTO proposal_row
  FROM public.action_proposals
  WHERE id = NEW.action_proposal_id
    AND organization_id = NEW.organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'clientops_agent_proposer audit event proposal is unavailable in the same organization';
  END IF;

  IF NEW.correlation_id IS DISTINCT FROM proposal_row.correlation_id
     OR NEW.approval_binding_hash IS DISTINCT FROM proposal_row.approval_binding_hash THEN
    RAISE EXCEPTION
      'clientops_agent_proposer audit event does not match authoritative proposal correlation/binding';
  END IF;

  IF NEW.event_type = 'ACTION_PROPOSED'
     AND NEW.parameter_hash IS DISTINCT FROM proposal_row.parameter_hash THEN
    RAISE EXCEPTION
      'ACTION_PROPOSED parameter hash does not match authoritative proposal';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clientops_agent_proposer_audit_events
  ON public.audit_events;
CREATE TRIGGER trg_clientops_agent_proposer_audit_events
BEFORE INSERT ON public.audit_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_clientops_agent_proposer_audit_events();

REVOKE EXECUTE ON FUNCTION
  public.enforce_clientops_agent_proposer_action_proposals()
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.enforce_clientops_agent_proposer_audit_events()
FROM PUBLIC, anon, authenticated;

-- The LOGIN role receives authority only through this single direct membership.
GRANT clientops_agent_proposer TO clientops_agent_staging_login;
