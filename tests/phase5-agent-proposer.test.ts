import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Phase 5.2.2 Agent proposer database boundary', () => {
  it('keeps cluster-level proposer roles outside normal migrations', () => {
    const sql = readFileSync(
      resolve(root, 'supabase/staging/004_clientops_agent_proposer.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE ROLE clientops_agent_proposer NOLOGIN');
    expect(sql).toContain(
      'CREATE ROLE clientops_agent_staging_login LOGIN INHERIT',
    );
    expect(sql).toContain(
      'GRANT clientops_agent_proposer TO clientops_agent_staging_login',
    );
    expect(sql).not.toMatch(/PASSWORD\s+'/i);
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public');
  });

  it('grants only proposal registration writes and no approval/execution/task authority', () => {
    const sql = readFileSync(
      resolve(root, 'supabase/staging/004_clientops_agent_proposer.sql'),
      'utf8',
    );

    expect(sql).toContain('GRANT UPDATE (status, updated_at)');
    expect(sql).toContain('ON public.action_proposals');
    expect(sql).toContain('GRANT INSERT (');
    expect(sql).toContain('ON public.audit_events TO clientops_agent_proposer');
    expect(sql).toContain('public.tasks');
    expect(sql).toContain('public.action_approvals');
    expect(sql).toContain('public.action_executions');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE');
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|UPDATE|INSERT).*public\.tasks/i);
    expect(sql).not.toMatch(
      /GRANT\s+(?:ALL|INSERT).*public\.action_approvals/i,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:ALL|INSERT).*public\.action_executions/i,
    );
  });

  it('database-enforces the proposer lifecycle and audit event allowlist', () => {
    const sql = readFileSync(
      resolve(root, 'supabase/staging/004_clientops_agent_proposer.sql'),
      'utf8',
    );

    expect(sql).toContain(
      'clientops_agent_proposer may transition only PROPOSED -> PENDING_APPROVAL',
    );
    expect(sql).toContain(
      "NEW.event_type NOT IN ('ACTION_PROPOSED', 'APPROVAL_REQUESTED')",
    );
    expect(sql).toContain(
      'audit event does not match authoritative proposal correlation/binding',
    );
    expect(sql).toContain(
      'ACTION_PROPOSED parameter hash does not match authoritative proposal',
    );
  });

  it('adds a durable organization/request correlation uniqueness constraint', () => {
    const migration = readFileSync(
      resolve(
        root,
        'supabase/migrations/20261012140700_phase5_2_proposal_idempotency.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('uq_action_proposals_org_correlation');
    expect(migration).toContain('UNIQUE (organization_id, correlation_id)');
    expect(migration).toContain(
      'duplicate (organization_id, correlation_id) rows exist',
    );
  });

  it('registers rollback-safe preflight and certification commands', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts['staging:agent-proposer:preflight']).toBe(
      'tsx scripts/staging-agent-proposer-preflight.ts',
    );
    expect(pkg.scripts['staging:agent-proposer:certify']).toBe(
      'tsx scripts/staging-agent-proposer-certify.ts',
    );
  });
});
