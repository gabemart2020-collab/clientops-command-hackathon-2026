import type { Pool } from 'pg';

export const MCP_READER_ROLE = 'clientops_mcp_reader';

export const MCP_REQUIRED_READ_TABLES = [
  'organizations',
  'users',
  'clients',
  'projects',
  'milestones',
  'tasks',
  'meetings',
  'communications',
  'commitments',
  'decisions',
] as const;

export const MCP_CONTROL_PLANE_TABLES = [
  'action_proposals',
  'action_approvals',
  'action_executions',
  'audit_events',
] as const;

export const MCP_PROTECTED_TABLES = [
  ...MCP_REQUIRED_READ_TABLES,
  ...MCP_CONTROL_PLANE_TABLES,
] as const;

export interface McpReaderDatabasePreflightReport {
  roleName: string;
  readerRoleMember: true;
  schemaUsage: true;
  schemaCreate: false;
  readableTables: number;
  protectedTables: number;
  forbiddenReadTables: number;
  otherRoleMemberships: 0;
}

async function relationExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ relation: string | null }>(
    'SELECT to_regclass($1)::text AS relation',
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.relation);
}

async function privilege(
  pool: Pool,
  table: string,
  name: string,
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
    [`public.${table}`, name],
  );
  return result.rows[0]?.allowed === true;
}

/**
 * Certifies that the connected staging role is an MCP reader and cannot mutate
 * ClientOps business/control-plane tables. This is intentionally executed
 * before the AgentCore listener starts.
 */
export async function assertMcpReaderDatabasePrivileges(
  pool: Pool,
): Promise<McpReaderDatabasePreflightReport> {
  const identity = await pool.query<{
    role_name: string;
    reader_role_member: boolean;
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
       pg_has_role(current_user, $1, 'MEMBER') AS reader_role_member,
       has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
       has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
       role.rolsuper AS role_superuser,
       role.rolcreatedb AS role_createdb,
       role.rolcreaterole AS role_createrole,
       role.rolreplication AS role_replication,
       role.rolbypassrls AS role_bypassrls
     FROM pg_roles AS role
     WHERE role.rolname = current_user`,
    [MCP_READER_ROLE],
  );

  const row = identity.rows[0];
  if (!row) {
    throw new Error('MCP staging database preflight failed: role unavailable.');
  }

  if (!row.reader_role_member) {
    throw new Error(
      'MCP staging database preflight failed: connected role is not a member of clientops_mcp_reader.',
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
      'MCP staging database preflight failed: connected role has elevated PostgreSQL role attributes.',
    );
  }

  const memberships = await pool.query<{
    reader_memberships: number;
    other_memberships: number;
    admin_memberships: number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE granted_role.rolname = $1
       )::int AS reader_memberships,
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
    [MCP_READER_ROLE],
  );

  const membership = memberships.rows[0];
  if (!membership || membership.reader_memberships !== 1) {
    throw new Error(
      'MCP staging database preflight failed: connected role must have exactly one direct clientops_mcp_reader membership.',
    );
  }

  if (
    membership.other_memberships !== 0 ||
    membership.admin_memberships !== 0
  ) {
    throw new Error(
      'MCP staging database preflight failed: connected role has additional role memberships.',
    );
  }

  if (!row.schema_usage) {
    throw new Error(
      'MCP staging database preflight failed: connected role lacks USAGE on public schema.',
    );
  }

  if (row.schema_create) {
    throw new Error(
      'MCP staging database preflight failed: connected role can CREATE in public schema.',
    );
  }

  for (const table of MCP_PROTECTED_TABLES) {
    if (!(await relationExists(pool, table))) {
      throw new Error(
        `MCP staging database preflight failed: required relation "${table}" is missing.`,
      );
    }

    const canWrite =
      (await privilege(pool, table, 'INSERT')) ||
      (await privilege(pool, table, 'UPDATE')) ||
      (await privilege(pool, table, 'DELETE')) ||
      (await privilege(pool, table, 'TRUNCATE')) ||
      (await privilege(pool, table, 'REFERENCES')) ||
      (await privilege(pool, table, 'TRIGGER'));

    if (canWrite) {
      throw new Error(
        `MCP staging database preflight failed: role has mutation privilege on "${table}".`,
      );
    }
  }

  for (const table of MCP_CONTROL_PLANE_TABLES) {
    if (await privilege(pool, table, 'SELECT')) {
      throw new Error(
        `MCP staging database preflight failed: role can read control-plane table "${table}".`,
      );
    }
  }

  for (const table of MCP_REQUIRED_READ_TABLES) {
    if (!(await privilege(pool, table, 'SELECT'))) {
      throw new Error(
        `MCP staging database preflight failed: role lacks SELECT on "${table}".`,
      );
    }
  }

  return {
    roleName: row.role_name,
    readerRoleMember: true,
    schemaUsage: true,
    schemaCreate: false,
    readableTables: MCP_REQUIRED_READ_TABLES.length,
    protectedTables: MCP_PROTECTED_TABLES.length,
    forbiddenReadTables: MCP_CONTROL_PLANE_TABLES.length,
    otherRoleMemberships: 0,
  };
}
