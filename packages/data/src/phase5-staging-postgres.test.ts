import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertMcpReaderDatabasePrivileges, runMigrations } from './index.js';

const { Pool } = pg;

const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev';
const readerRole = 'clientops_mcp_runtime_test';
const readerPassword = randomBytes(24).toString('hex');

describe('Phase 5.1 real PostgreSQL MCP reader certification', () => {
  let adminPool: pg.Pool;
  let readerPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl });
    await runMigrations(adminPool);

    const roleSql = readFileSync(
      resolve(process.cwd(), 'supabase/staging/001_clientops_mcp_reader.sql'),
      'utf8',
    );
    await adminPool.query(roleSql);

    await adminPool.query(`DROP ROLE IF EXISTS ${readerRole}`);
    await adminPool.query(
      `CREATE ROLE ${readerRole}
         LOGIN
         INHERIT
         NOSUPERUSER
         NOCREATEDB
         NOCREATEROLE
         NOREPLICATION
         NOBYPASSRLS
         PASSWORD '${readerPassword}'`,
    );
    await adminPool.query(`GRANT clientops_mcp_reader TO ${readerRole}`);

    const url = new URL(adminUrl);
    url.username = readerRole;
    url.password = readerPassword;
    readerPool = new Pool({ connectionString: url.toString() });
  });

  afterAll(async () => {
    await readerPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP ROLE IF EXISTS ${readerRole}`);
      await adminPool.end();
    }
  });

  it('passes the real least-privilege staging preflight', async () => {
    const report = await assertMcpReaderDatabasePrivileges(readerPool);

    expect(report).toMatchObject({
      roleName: readerRole,
      readerRoleMember: true,
      schemaUsage: true,
      schemaCreate: false,
      readableTables: 10,
      protectedTables: 14,
      forbiddenReadTables: 4,
      otherRoleMemberships: 0,
    });
  });

  it('can read business truth but cannot read the Phase 4 control plane', async () => {
    await expect(
      readerPool.query('SELECT COUNT(*) FROM organizations'),
    ).resolves.toBeDefined();

    await expect(
      readerPool.query('SELECT COUNT(*) FROM action_proposals'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot mutate business tables even with a no-op predicate', async () => {
    await expect(
      readerPool.query('UPDATE tasks SET title = title WHERE false'),
    ).rejects.toThrow(/permission denied/i);
  });
});
