import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  AGENT_PROPOSER_AUDIT_INSERT_COLUMNS,
  AGENT_PROPOSER_FORBIDDEN_READ_TABLES,
  AGENT_PROPOSER_PROPOSAL_FROZEN_COLUMNS,
  AGENT_PROPOSER_PROPOSAL_INSERT_COLUMNS,
  AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS,
  AGENT_PROPOSER_PROTECTED_TABLES,
  AGENT_PROPOSER_REQUIRED_READ_TABLES,
  assertAgentProposerDatabasePrivileges,
} from './agent-proposer-preflight.js';

interface FakeOptions {
  member?: boolean;
  schemaUsage?: boolean;
  schemaCreate?: boolean;
  elevated?: boolean;
  proposerMemberships?: number;
  otherMemberships?: number;
  adminMemberships?: number;
  missingTable?: string;
  forbiddenReadTable?: string;
  protectedWriteTable?: string;
  missingInsertColumn?: string;
  missingUpdateColumn?: string;
  frozenUpdateColumn?: string;
  auditUpdate?: boolean;
}

function fakePool(options: FakeOptions = {}): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('current_user AS role_name')) {
      return {
        rows: [
          {
            role_name: 'clientops_agent_staging_login.project',
            proposer_role_member: options.member ?? true,
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
            proposer_memberships: options.proposerMemberships ?? 1,
            other_memberships: options.otherMemberships ?? 0,
            admin_memberships: options.adminMemberships ?? 0,
          },
        ],
      };
    }

    if (sql.includes('to_regclass')) {
      const table = String(params[0]).replace('public.', '');
      return {
        rows: [
          {
            relation: table === options.missingTable ? null : `public.${table}`,
          },
        ],
      };
    }

    if (sql.includes('has_column_privilege')) {
      const table = String(params[0]).replace('public.', '');
      const column = String(params[1]);
      const privilege = String(params[2]);

      if (table === 'action_proposals' && privilege === 'INSERT') {
        return {
          rows: [{ allowed: column !== options.missingInsertColumn }],
        };
      }

      if (table === 'action_proposals' && privilege === 'UPDATE') {
        const allowed =
          AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS.includes(
            column as (typeof AGENT_PROPOSER_PROPOSAL_UPDATE_COLUMNS)[number],
          ) && column !== options.missingUpdateColumn;
        return {
          rows: [
            {
              allowed: allowed || column === options.frozenUpdateColumn,
            },
          ],
        };
      }

      if (table === 'audit_events' && privilege === 'INSERT') {
        return {
          rows: [{ allowed: column !== options.missingInsertColumn }],
        };
      }

      return { rows: [{ allowed: false }] };
    }

    if (sql.includes('has_any_column_privilege')) {
      const table = String(params[0]).replace('public.', '');
      const privilege = String(params[1]);

      if (privilege === 'SELECT' && table === options.forbiddenReadTable) {
        return { rows: [{ allowed: true }] };
      }

      if (
        ['INSERT', 'UPDATE'].includes(privilege) &&
        table === options.protectedWriteTable
      ) {
        return { rows: [{ allowed: true }] };
      }

      if (
        table === 'audit_events' &&
        privilege === 'UPDATE' &&
        options.auditUpdate
      ) {
        return { rows: [{ allowed: true }] };
      }

      return { rows: [{ allowed: false }] };
    }

    if (sql.includes('has_table_privilege')) {
      const table = String(params[0]).replace('public.', '');
      const privilege = String(params[1]);

      if (privilege === 'SELECT') {
        return {
          rows: [
            {
              allowed:
                AGENT_PROPOSER_REQUIRED_READ_TABLES.includes(
                  table as (typeof AGENT_PROPOSER_REQUIRED_READ_TABLES)[number],
                ) && table !== options.forbiddenReadTable,
            },
          ],
        };
      }

      if (table === options.protectedWriteTable && privilege === 'DELETE') {
        return { rows: [{ allowed: true }] };
      }

      return { rows: [{ allowed: false }] };
    }

    throw new Error(`Unexpected proposer preflight query: ${sql}`);
  };

  return { query } as unknown as Pool;
}

describe('Phase 5.2.2 Agent proposer privilege preflight', () => {
  it('accepts exactly the frozen proposer privilege envelope', async () => {
    const report = await assertAgentProposerDatabasePrivileges(fakePool());

    expect(report).toMatchObject({
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
    });
  });

  it('requires exactly one direct proposer membership and no extras', async () => {
    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ proposerMemberships: 0 }),
      ),
    ).rejects.toThrow(/exactly one direct clientops_agent_proposer membership/);

    await expect(
      assertAgentProposerDatabasePrivileges(fakePool({ otherMemberships: 1 })),
    ).rejects.toThrow(/additional role memberships/);
  });

  it('rejects forbidden reads and protected business mutations', async () => {
    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ forbiddenReadTable: 'audit_events' }),
      ),
    ).rejects.toThrow(/can read forbidden table "audit_events"/);

    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ protectedWriteTable: 'tasks' }),
      ),
    ).rejects.toThrow(/mutation privilege on "tasks"/);
  });

  it('rejects UPDATE authority on any frozen proposal column', async () => {
    const frozen = AGENT_PROPOSER_PROPOSAL_FROZEN_COLUMNS[0];
    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ frozenUpdateColumn: frozen }),
      ),
    ).rejects.toThrow(/can UPDATE frozen proposal column/);
  });

  it('rejects missing required proposal/audit column grants', async () => {
    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ missingInsertColumn: 'correlation_id' }),
      ),
    ).rejects.toThrow(/lacks INSERT/);

    await expect(
      assertAgentProposerDatabasePrivileges(
        fakePool({ missingUpdateColumn: 'status' }),
      ),
    ).rejects.toThrow(/lacks UPDATE on action_proposals.status/);
  });

  it('rejects elevated role attributes, schema CREATE, and audit UPDATE', async () => {
    await expect(
      assertAgentProposerDatabasePrivileges(fakePool({ elevated: true })),
    ).rejects.toThrow(/elevated PostgreSQL role attributes/);

    await expect(
      assertAgentProposerDatabasePrivileges(fakePool({ schemaCreate: true })),
    ).rejects.toThrow(/can CREATE in public schema/);

    await expect(
      assertAgentProposerDatabasePrivileges(fakePool({ auditUpdate: true })),
    ).rejects.toThrow(/forbidden audit_events authority/);
  });
});
