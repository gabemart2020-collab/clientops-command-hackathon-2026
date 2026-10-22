import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  assertConfiguredDatabaseTarget,
  assertLocalDatabaseTarget,
  assertStagingDatabaseTarget,
  connectionStringForVerifiedStagingTls,
  readDatabaseSafetyConfig,
} from './target-policy.js';
import {
  closeDatabasePool,
  getDatabasePool,
  readStagingDatabaseCa,
} from './pool.js';
import {
  assertMcpReaderDatabasePrivileges,
  MCP_CONTROL_PLANE_TABLES,
  MCP_PROTECTED_TABLES,
  MCP_REQUIRED_READ_TABLES,
} from './staging-preflight.js';

const stagingEnv = {
  CLIENTOPS_DATABASE_TARGET: 'staging',
  CLIENTOPS_ENVIRONMENT: 'staging',
  CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
  CLIENTOPS_STAGING_DB_HOST: 'db.staging.example',
  CLIENTOPS_STAGING_DB_NAME: 'clientops_stage',
  CLIENTOPS_STAGING_DB_USER: 'reader',
};

const stagingUrl =
  'postgresql://reader@db.staging.example:5432/clientops_stage?sslmode=verify-full';

const stagingCaPem =
  '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

describe('Phase 5.1 database target policy', () => {
  it('defaults to the existing local-only policy', () => {
    expect(readDatabaseSafetyConfig({})).toEqual({ target: 'local' });
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://reader@127.0.0.1:5432/clientops_dev',
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://reader@[::1]:5432/clientops_test',
      ),
    ).not.toThrow();
  });

  it('requires an explicit staging environment and exact host/database allowlist', () => {
    expect(() =>
      readDatabaseSafetyConfig({
        CLIENTOPS_DATABASE_TARGET: 'staging',
      }),
    ).toThrow(/CLIENTOPS_ENVIRONMENT=staging/);

    expect(() =>
      readDatabaseSafetyConfig({
        CLIENTOPS_DATABASE_TARGET: 'staging',
        CLIENTOPS_ENVIRONMENT: 'staging',
      }),
    ).toThrow(
      /CLIENTOPS_DATABASE_WORKLOAD=mcp or CLIENTOPS_DATABASE_WORKLOAD=agent-proposer/,
    );

    expect(readDatabaseSafetyConfig(stagingEnv)).toEqual({
      target: 'staging',
      environment: 'staging',
      workload: 'mcp',
      stagingHost: 'db.staging.example',
      stagingDatabase: 'clientops_stage',
      stagingUser: 'reader',
    });

    expect(
      readDatabaseSafetyConfig({
        ...stagingEnv,
        CLIENTOPS_DATABASE_WORKLOAD: 'agent-proposer',
        CLIENTOPS_STAGING_DB_USER: 'clientops_agent_staging_login.project',
      }),
    ).toEqual({
      target: 'staging',
      environment: 'staging',
      workload: 'agent-proposer',
      stagingHost: 'db.staging.example',
      stagingDatabase: 'clientops_stage',
      stagingUser: 'clientops_agent_staging_login.project',
    });
  });

  it('accepts only the exact configured TLS staging target', () => {
    const config = readDatabaseSafetyConfig(stagingEnv);
    if (config.target !== 'staging') throw new Error('Expected staging config');

    expect(() => assertStagingDatabaseTarget(stagingUrl, config)).not.toThrow();

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@other.example:5432/clientops_stage?sslmode=require',
        config,
      ),
    ).toThrow(/host does not match/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@db.staging.example:5432/other_db?sslmode=require',
        config,
      ),
    ).toThrow(/database name does not match/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://other_reader@db.staging.example:5432/clientops_stage?sslmode=require',
        config,
      ),
    ).toThrow(/database user does not match/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@db.staging.example:5432/clientops_stage',
        config,
      ),
    ).toThrow(/requires sslmode=verify-full/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@db.staging.example:5432/clientops_stage?sslmode=require',
        config,
      ),
    ).toThrow(/requires sslmode=verify-full/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@db.staging.example:5432/clientops_stage?sslmode=verify-ca',
        config,
      ),
    ).toThrow(/requires sslmode=verify-full/);

    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@db.staging.example:5432/clientops_stage?sslmode=verify-full&sslrootcert=/tmp/root.crt',
        config,
      ),
    ).toThrow(/TLS file options are not permitted/);
  });

  it('removes validated sslmode before Pool applies verified TLS options', () => {
    const normalized = new URL(
      connectionStringForVerifiedStagingTls(stagingUrl),
    );
    expect(normalized.searchParams.has('sslmode')).toBe(false);
    expect(normalized.hostname).toBe('db.staging.example');
    expect(normalized.pathname).toBe('/clientops_stage');
  });

  it('never permits staging mode to target a local database', () => {
    const config = {
      target: 'staging' as const,
      environment: 'staging' as const,
      workload: 'mcp' as const,
      stagingHost: '127.0.0.1',
      stagingDatabase: 'clientops_stage',
      stagingUser: 'reader',
    };
    expect(() =>
      assertStagingDatabaseTarget(
        'postgresql://reader@127.0.0.1:5432/clientops_stage?sslmode=require',
        config,
      ),
    ).toThrow(/requires the exact configured remote staging host/);
  });

  it('routes configured assertions through local or staging policy', () => {
    expect(() =>
      assertConfiguredDatabaseTarget(stagingUrl, stagingEnv),
    ).not.toThrow();

    expect(() =>
      assertConfiguredDatabaseTarget(stagingUrl, {
        CLIENTOPS_DATABASE_TARGET: 'local',
      }),
    ).toThrow(/non-local host/);
  });

  it('requires DATABASE_URL in staging and never falls back to SUPABASE_DB_URL', () => {
    expect(() =>
      getDatabasePool(undefined, undefined, {
        ...stagingEnv,
        SUPABASE_DB_URL: stagingUrl,
      }),
    ).toThrow(
      /Staging database access requires DATABASE_URL; SUPABASE_DB_URL fallback is disabled/,
    );
  });

  it('requires an explicit bounded Supabase CA file for staging', () => {
    expect(() => readStagingDatabaseCa(stagingEnv)).toThrow(
      /CLIENTOPS_STAGING_DB_CA_FILE/,
    );

    expect(() =>
      readStagingDatabaseCa({
        ...stagingEnv,
        CLIENTOPS_STAGING_DB_CA_FILE: 'relative/ca.crt',
      }),
    ).toThrow(/absolute CLIENTOPS_STAGING_DB_CA_FILE/);

    const dir = mkdtempSync(join(tmpdir(), 'clientops-staging-ca-'));
    const caFile = join(dir, 'ca.crt');
    const badFile = join(dir, 'bad.crt');

    try {
      writeFileSync(caFile, stagingCaPem, 'utf8');
      writeFileSync(badFile, 'not a pem', 'utf8');

      expect(
        readStagingDatabaseCa({
          ...stagingEnv,
          CLIENTOPS_STAGING_DB_CA_FILE: caFile,
        }),
      ).toBe(`${stagingCaPem}\n`);

      expect(() =>
        readStagingDatabaseCa({
          ...stagingEnv,
          CLIENTOPS_STAGING_DB_CA_FILE: badFile,
        }),
      ).toThrow(/must contain a PEM certificate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(() =>
      getDatabasePool(undefined, undefined, {
        ...stagingEnv,
        DATABASE_URL: stagingUrl,
      }),
    ).toThrow(/CLIENTOPS_STAGING_DB_CA_FILE/);
  });

  it('fails closed without echoing malformed connection strings', () => {
    const malformed = 'not-a-database-url-with-sensitive-material';
    expect(() => assertLocalDatabaseTarget(malformed)).toThrow(
      'Database safety check failed: Invalid connection string URL.',
    );
    try {
      assertLocalDatabaseTarget(malformed);
    } catch (error) {
      expect((error as Error).message).not.toContain(malformed);
    }
  });

  it('pins one process to one validated database target', async () => {
    getDatabasePool(
      'postgresql://reader@127.0.0.1:5432/clientops_dev',
      undefined,
      { CLIENTOPS_DATABASE_TARGET: 'local' },
    );

    try {
      expect(() =>
        getDatabasePool(
          'postgresql://different_reader@127.0.0.1:5432/clientops_dev',
          undefined,
          { CLIENTOPS_DATABASE_TARGET: 'local' },
        ),
      ).toThrow(/already initialized for a different validated target/);
    } finally {
      await closeDatabasePool();
    }
  });
});

interface FakePrivilegeOptions {
  member?: boolean;
  schemaUsage?: boolean;
  schemaCreate?: boolean;
  elevated?: boolean;
  readerMemberships?: number;
  otherMemberships?: number;
  adminMemberships?: number;
  missingTable?: string;
  writeTable?: string;
  unreadableTable?: string;
  readableControlPlaneTable?: string;
}

function fakePool(options: FakePrivilegeOptions = {}): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('current_user AS role_name')) {
      return {
        rows: [
          {
            role_name: 'clientops_mcp_runtime',
            reader_role_member: options.member ?? true,
            schema_usage: options.schemaUsage ?? true,
            schema_create: options.schemaCreate ?? false,
            role_superuser: options.elevated ?? false,
            role_createdb: false,
            role_createrole: false,
            role_replication: false,
            role_bypassrls: false,
          },
        ],
      };
    }

    if (sql.includes('FROM pg_auth_members AS membership')) {
      return {
        rows: [
          {
            reader_memberships: options.readerMemberships ?? 1,
            other_memberships: options.otherMemberships ?? 0,
            admin_memberships: options.adminMemberships ?? 0,
          },
        ],
      };
    }

    if (sql.includes('to_regclass')) {
      const relation = String(params[0]);
      const table = relation.replace('public.', '');
      return {
        rows: [
          {
            relation: table === options.missingTable ? null : `public.${table}`,
          },
        ],
      };
    }

    if (sql.includes('has_table_privilege')) {
      const relation = String(params[0]);
      const table = relation.replace('public.', '');
      const privilege = String(params[1]);

      if (privilege === 'SELECT') {
        const allowed =
          table === options.readableControlPlaneTable ||
          (!MCP_CONTROL_PLANE_TABLES.includes(
            table as (typeof MCP_CONTROL_PLANE_TABLES)[number],
          ) &&
            table !== options.unreadableTable);
        return { rows: [{ allowed }] };
      }

      return {
        rows: [
          {
            allowed: table === options.writeTable && privilege === 'INSERT',
          },
        ],
      };
    }

    throw new Error(`Unexpected preflight query: ${sql}`);
  };

  return { query } as unknown as Pool;
}

describe('Phase 5.1 MCP staging privilege preflight', () => {
  it('accepts a member role with required reads and zero mutation privileges', async () => {
    const report = await assertMcpReaderDatabasePrivileges(fakePool());
    expect(report).toMatchObject({
      roleName: 'clientops_mcp_runtime',
      readerRoleMember: true,
      schemaUsage: true,
      schemaCreate: false,
      readableTables: MCP_REQUIRED_READ_TABLES.length,
      protectedTables: MCP_PROTECTED_TABLES.length,
      forbiddenReadTables: MCP_CONTROL_PLANE_TABLES.length,
      otherRoleMemberships: 0,
    });
  });

  it('rejects a role that is not a clientops_mcp_reader member', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ member: false })),
    ).rejects.toThrow(/not a member of clientops_mcp_reader/);
  });

  it('rejects missing USAGE on the public schema', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ schemaUsage: false })),
    ).rejects.toThrow(/lacks USAGE on public schema/);
  });

  it('rejects CREATE privilege on the public schema', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ schemaCreate: true })),
    ).rejects.toThrow(/can CREATE in public schema/);
  });

  it('rejects elevated PostgreSQL role attributes', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ elevated: true })),
    ).rejects.toThrow(/elevated PostgreSQL role attributes/);
  });

  it('requires exactly one direct MCP reader membership', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ readerMemberships: 0 })),
    ).rejects.toThrow(/exactly one direct clientops_mcp_reader membership/);
  });

  it('rejects additional role memberships', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ otherMemberships: 1 })),
    ).rejects.toThrow(/additional role memberships/);

    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ adminMemberships: 1 })),
    ).rejects.toThrow(/additional role memberships/);
  });

  it('rejects missing required schema objects', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(
        fakePool({ missingTable: 'action_executions' }),
      ),
    ).rejects.toThrow(/required relation "action_executions" is missing/);
  });

  it('rejects any mutation privilege on protected tables', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(fakePool({ writeTable: 'tasks' })),
    ).rejects.toThrow(/mutation privilege on "tasks"/);
  });

  it('rejects read access to Phase 4 control-plane tables', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(
        fakePool({ readableControlPlaneTable: 'action_proposals' }),
      ),
    ).rejects.toThrow(/can read control-plane table "action_proposals"/);
  });

  it('rejects missing SELECT on an MCP business table', async () => {
    await expect(
      assertMcpReaderDatabasePrivileges(
        fakePool({ unreadableTable: 'communications' }),
      ),
    ).rejects.toThrow(/lacks SELECT on "communications"/);
  });
});
