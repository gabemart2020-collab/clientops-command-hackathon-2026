-- Phase 5.1 staging-only least-privilege group role for AgentCore MCP.
-- Apply only to the isolated non-production ClientOps staging database after
-- the normal additive schema migrations. This file is intentionally outside
-- supabase/migrations so local db:reset never creates cluster-level roles.
--
-- A separate LOGIN role with a securely generated password must be created by
-- the operator and granted membership in clientops_mcp_reader. Do not commit
-- that login password or connection string.

DO $clientops$
DECLARE
  reader_role RECORD;
BEGIN
  SELECT
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls
  INTO reader_role
  FROM pg_roles
  WHERE rolname = 'clientops_mcp_reader';

  IF NOT FOUND THEN
    -- PostgreSQL defaults are NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
    -- NOREPLICATION, and NOBYPASSRLS. Avoid ALTER ROLE on those
    -- superuser-governed attributes so this works with Supabase's managed
    -- administrative execution context.
    CREATE ROLE clientops_mcp_reader NOLOGIN NOINHERIT;

    SELECT
      rolcanlogin,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls
    INTO reader_role
    FROM pg_roles
    WHERE rolname = 'clientops_mcp_reader';
  END IF;

  -- Fail closed instead of attempting to repair an unexpectedly elevated
  -- pre-existing role. Repair requires a separately authorized admin path.
  IF reader_role.rolcanlogin
     OR reader_role.rolsuper
     OR reader_role.rolcreatedb
     OR reader_role.rolcreaterole
     OR reader_role.rolreplication
     OR reader_role.rolbypassrls THEN
    RAISE EXCEPTION
      'clientops_mcp_reader has elevated or LOGIN attributes; refusing provisioning';
  END IF;
END
$clientops$;

REVOKE CREATE ON SCHEMA public FROM clientops_mcp_reader;
GRANT USAGE ON SCHEMA public TO clientops_mcp_reader;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM clientops_mcp_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM clientops_mcp_reader;

GRANT SELECT ON TABLE
  organizations,
  users,
  clients,
  projects,
  milestones,
  tasks,
  meetings,
  communications,
  commitments,
  decisions
TO clientops_mcp_reader;

-- Defense in depth: the model-facing MCP role receives no access to the
-- Phase 4 control-plane tables even for reads.
REVOKE ALL PRIVILEGES ON TABLE
  action_proposals,
  action_approvals,
  action_executions,
  audit_events
FROM clientops_mcp_reader;
