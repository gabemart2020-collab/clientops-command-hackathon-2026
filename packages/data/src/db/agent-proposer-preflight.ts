import type { Pool } from 'pg';

export const AGENT_PROPOSER_ROLE = 'clientops_agent_proposer';

export const AGENT_PROPOSER_REQUIRED_READ_TABLES = [
  'clients',
  'projects',
  'users',
  'milestones',
  'action_proposals',
] as const;

export const AGENT_PROPOSER_FORBIDDEN_READ_TABLES = [
  'tasks',
  'action_approvals',
  'action_executions',
  'audit_events',
] as const;

export const AGENT_PROPOSER_PROTECTED_TABLES = [
  'tasks',
  'action_approvals',
  'action_executions',
] as const;

export const AGENT_PROPOSER_PROPOSAL_INSERT_COLUMNS = [
  'id',
  'organization_id',
  'action_type',
  'action_class',
  'parameters',
  'parameter_hash',
  'approval_binding_hash',
  'correlation_id',
  'evidence',
  'preconditions',
  'status',
  'justification',
  'created_at',
  'expires_at',
  'updated_at',
] as const;

export const AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS = [
  'status',
  'updated_at',
] as const;

export const AGENT_PROPOSER_PROPOSAL_FROZEN_COLUMNS = [
  'id',
  'organization_id',
  'action_type',
  'action_class',
  'parameters',
  'parameter_hash',
  'approval_binding_hash',
  'correlation_id',
  'evidence',
  'preconditions',
  'justification',
  'created_at',
  'expires_at',
] as const;

export const AGENT_PROPOSER_AUDIT_INSERT_COLUMNS = [
  'id',
  'organization_id',
  'action_proposal_id',
  'event_type',
  'actor_id',
  'parameter_hash',
  'approval_binding_hash',
  'correlation_id',
  'payload',
  'occurred_at',
] as const;

export interface AgentProposerDatabasePreflightReport {
  roleName: string;
  proposerRoleMember: true;
  schemaUsage: true;
  schemaCreate: false;
  readableTables: number;
  forbiddenReadTables: number;
  protectedTables: number;
  proposalInsertColumns: number;
  proposalUpdateColumns: number;
  auditInsertColumns: number;
  otherRoleMemberships: 0;
}

async function relationExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ relation: string | null }>(
    'SELECT to_regclass($1)::text AS relation',
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.relation);
}

async function tablePrivilege(
  pool: Pool,
  table: string,
  privilege: string,
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
    [`public.${table}`, privilege],
  );
  return result.rows[0]?.allowed === true;
}

async function anyColumnPrivilege(
  pool: Pool,
  table: string,
  privilege: 'INSERT' | 'UPDATE' | 'SELECT',
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    'SELECT has_any_column_privilege(current_user, $1, $2) AS allowed',
    [`public.${table}`, privilege],
  );
  return result.rows[0]?.allowed === true;
}

async function columnPrivilege(
  pool: Pool,
  table: string,
  column: string,
  privilege: 'INSERT' | 'UPDATE' | 'SELECT',
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    'SELECT has_column_privilege(current_user, $1, $2, $3) AS allowed',
    [`public.${table}`, column, privilege],
  );
  return result.rows[0]?.allowed === true;
}

async function assertNoTableMutationPrivilege(
  pool: Pool,
  table: string,
): Promise<void> {
  const canMutate =
    (await anyColumnPrivilege(pool, table, 'INSERT')) ||
    (await anyColumnPrivilege(pool, table, 'UPDATE')) ||
    (await tablePrivilege(pool, table, 'DELETE')) ||
    (await tablePrivilege(pool, table, 'TRUNCATE')) ||
    (await tablePrivilege(pool, table, 'REFERENCES')) ||
    (await tablePrivilege(pool, table, 'TRIGGER'));

  if (canMutate) {
    throw new Error(
      `Agent proposer staging database preflight failed: role has mutation privilege on "${table}".`,
    );
  }
}

export async function assertAgentProposerDatabasePrivileges(
  pool: Pool,
): Promise<AgentProposerDatabasePreflightReport> {
  const identity = await pool.query<{
    role_name: string;
    proposer_role_member: boolean;
    schema_usage: boolean;
    schema_create: boolean;
    role_superuser: boolean;
    role_createdb: boolean;
    role_createrole: boolean;
    role_replication: boolean;
    role_bypassrls: boolean;
  }>(
    `SELECT
       current_user AS role_name,
       pg_has_role(current_user, $1, 'MEMBER') AS proposer_role_member,
       has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
       has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
       role.rolsuper AS role_superuser,
       role.rolcreatedb AS role_createdb,
       role.rolcreaterole AS role_createrole,
       role.rolreplication AS role_replication,
       role.rolbypassrls AS role_bypassrls
     FROM pg_roles AS role
     WHERE role.rolname = current_user`,
    [AGENT_PROPOSER_ROLE],
  );

  const row = identity.rows[0];
  if (!row) {
    throw new Error(
      'Agent proposer staging database preflight failed: role unavailable.',
    );
  }

  if (!row.proposer_role_member) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role is not a member of clientops_agent_proposer.',
    );
  }

  if (
    row.role_superuser ||
    row.role_createdb ||
    row.role_createrole ||
    row.role_replication ||
    row.role_bypassrls
  ) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role has elevated PostgreSQL role attributes.',
    );
  }

  const memberships = await pool.query<{
    proposer_memberships: number;
    other_memberships: number;
    admin_memberships: number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE granted_role.rolname = $1
       )::int AS proposer_memberships,
       COUNT(*) FILTER (
         WHERE granted_role.rolname <> $1
       )::int AS other_memberships,
       COUNT(*) FILTER (
         WHERE membership.admin_option
       )::int AS admin_memberships
     FROM pg_auth_members AS membership
     JOIN pg_roles AS member_role
       ON member_role.oid = membership.member
     JOIN pg_roles AS granted_role
       ON granted_role.oid = membership.roleid
     WHERE member_role.rolname = current_user`,
    [AGENT_PROPOSER_ROLE],
  );

  const membership = memberships.rows[0];
  if (!membership || membership.proposer_memberships !== 1) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role must have exactly one direct clientops_agent_proposer membership.',
    );
  }
  if (
    membership.other_memberships !== 0 ||
    membership.admin_memberships !== 0
  ) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role has additional role memberships.',
    );
  }

  if (!row.schema_usage) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role lacks USAGE on public schema.',
    );
  }
  if (row.schema_create) {
    throw new Error(
      'Agent proposer staging database preflight failed: connected role can CREATE in public schema.',
    );
  }

  const allTables = [
    ...AGENT_PROPOSER_REQUIRED_READ_TABLES,
    ...AGENT_PROPOSER_FORBIDDEN_READ_TABLES,
  ];
  for (const table of new Set(allTables)) {
    if (!(await relationExists(pool, table))) {
      throw new Error(
        `Agent proposer staging database preflight failed: required relation "${table}" is missing.`,
      );
    }
  }

  for (const table of AGENT_PROPOSER_REQUIRED_READ_TABLES) {
    if (!(await tablePrivilege(pool, table, 'SELECT'))) {
      throw new Error(
        `Agent proposer staging database preflight failed: role lacks SELECT on "${table}".`,
      );
    }
  }

  for (const table of AGENT_PROPOSER_FORBIDDEN_READ_TABLES) {
    if (
      (await tablePrivilege(pool, table, 'SELECT')) ||
      (await anyColumnPrivilege(pool, table, 'SELECT'))
    ) {
      throw new Error(
        `Agent proposer staging database preflight failed: role can read forbidden table "${table}".`,
      );
    }
  }

  for (const column of AGENT_PROPOSER_PROPOSAL_INSERT_COLUMNS) {
    if (!(await columnPrivilege(pool, 'action_proposals', column, 'INSERT'))) {
      throw new Error(
        `Agent proposer staging database preflight failed: role lacks INSERT on action_proposals.${column}.`,
      );
    }
  }

  for (const column of AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS) {
    if (!(await columnPrivilege(pool, 'action_proposals', column, 'UPDATE'))) {
      throw new Error(
        `Agent proposer staging database preflight failed: role lacks UPDATE on action_proposals.${column}.`,
      );
    }
  }

  for (const column of AGENT_PROPOSER_PROPOSAL_FROZEN_COLUMNS) {
    if (await columnPrivilege(pool, 'action_proposals', column, 'UPDATE')) {
      throw new Error(
        `Agent proposer staging database preflight failed: role can UPDATE frozen proposal column "${column}".`,
      );
    }
  }

  if (
    (await tablePrivilege(pool, 'action_proposals', 'DELETE')) ||
    (await tablePrivilege(pool, 'action_proposals', 'TRUNCATE')) ||
    (await tablePrivilege(pool, 'action_proposals', 'REFERENCES')) ||
    (await tablePrivilege(pool, 'action_proposals', 'TRIGGER'))
  ) {
    throw new Error(
      'Agent proposer staging database preflight failed: role has forbidden table-level action_proposals authority.',
    );
  }

  for (const column of AGENT_PROPOSER_AUDIT_INSERT_COLUMNS) {
    if (!(await columnPrivilege(pool, 'audit_events', column, 'INSERT'))) {
      throw new Error(
        `Agent proposer staging database preflight failed: role lacks INSERT on audit_events.${column}.`,
      );
    }
  }

  if (
    (await anyColumnPrivilege(pool, 'audit_events', 'UPDATE')) ||
    (await tablePrivilege(pool, 'audit_events', 'DELETE')) ||
    (await tablePrivilege(pool, 'audit_events', 'TRUNCATE')) ||
    (await tablePrivilege(pool, 'audit_events', 'REFERENCES')) ||
    (await tablePrivilege(pool, 'audit_events', 'TRIGGER'))
  ) {
    throw new Error(
      'Agent proposer staging database preflight failed: role has forbidden audit_events authority.',
    );
  }

  for (const table of AGENT_PROPOSER_PROTECTED_TABLES) {
    await assertNoTableMutationPrivilege(pool, table);
  }

  return {
    roleName: row.role_name,
    proposerRoleMember: true,
    schemaUsage: true,
    schemaCreate: false,
    readableTables: AGENT_PROPOSER_REQUIRED_READ_TABLES.length,
    forbiddenReadTables: AGENT_PROPOSER_FORBIDDEN_READ_TABLES.length,
    protectedTables: AGENT_PROPOSER_PROTECTED_TABLES.length,
    proposalInsertColumns: AGENT_PROPOSER_PROPOSAL_INSERT_COLUMNS.length,
    proposalUpdateColumns: AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS.length,
    auditInsertColumns: AGENT_PROPOSER_AUDIT_INSERT_COLUMNS.length,
    otherRoleMemberships: 0,
  };
}
