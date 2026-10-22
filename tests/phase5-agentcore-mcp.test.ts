import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Phase 5.1 AgentCore MCP deployment contract', () => {
  it('pins the MCP container to Node 24, ARM64, port 8000, and AgentCore mode', () => {
    const dockerfile = readFileSync(
      resolve(root, 'services/mcp/Dockerfile.agentcore'),
      'utf8',
    );

    expect(dockerfile).toContain('--platform=linux/arm64');
    expect(dockerfile).toContain('node:24-alpine AS builder');
    expect(dockerfile).toContain('node:24-alpine AS runtime');
    expect(dockerfile).toContain('CLIENTOPS_MCP_RUNTIME=agentcore');
    expect(dockerfile).toContain('CLIENTOPS_DATABASE_TARGET=staging');
    expect(dockerfile).toContain('CLIENTOPS_DATABASE_WORKLOAD=mcp');
    expect(dockerfile).toContain('MCP_BIND_HOST=0.0.0.0');
    expect(dockerfile).toContain('MCP_PORT=8000');
    expect(dockerfile).toContain('MCP_PROTOCOL_VERSION=2025-11-25');
    expect(dockerfile).toContain('EXPOSE 8000');
    expect(dockerfile).toContain('USER node');
  });

  it('requires explicit verified Supabase CA trust for staging and AgentCore', () => {
    const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
    const runbook = readFileSync(
      resolve(root, 'docs/PHASE5_1_RUNBOOK.md'),
      'utf8',
    );
    const poolSource = readFileSync(
      resolve(root, 'packages/data/src/db/pool.ts'),
      'utf8',
    );
    const targetPolicy = readFileSync(
      resolve(root, 'packages/data/src/db/target-policy.ts'),
      'utf8',
    );

    expect(envExample).toContain('CLIENTOPS_STAGING_DB_CA_FILE=');
    expect(envExample).toContain('CLIENTOPS_DATABASE_URL_SECRET_ARN=');
    expect(runbook).toContain('CLIENTOPS_STAGING_DB_CA_FILE');
    expect(runbook).toContain('sslmode=verify-full');
    expect(runbook).toContain('rejectUnauthorized: true');
    expect(runbook).toContain('rejectUnauthorized: false');
    expect(poolSource).toContain('CLIENTOPS_STAGING_DB_CA_FILE');
    expect(poolSource).toContain('rejectUnauthorized: true, ca: stagingCa');
    expect(targetPolicy).toContain(
      'staging PostgreSQL requires sslmode=verify-full.',
    );
    expect(poolSource).not.toContain('rejectUnauthorized: false');

    const secretSource = readFileSync(
      resolve(root, 'services/mcp/src/database-secret.ts'),
      'utf8',
    );
    expect(secretSource).toContain('CLIENTOPS_DATABASE_URL_SECRET_ARN');
    expect(secretSource).toContain('GetSecretValueCommand');
    expect(secretSource).toContain('delete env.DATABASE_URL');

    const dockerfile = readFileSync(
      resolve(root, 'services/mcp/Dockerfile.agentcore'),
      'utf8',
    );
    expect(dockerfile).toContain(
      '--mount=type=secret,id=clientops_supabase_ca,required=true',
    );
    expect(dockerfile).toContain(
      'CLIENTOPS_STAGING_DB_CA_FILE=/app/certs/clientops-supabase-ca.crt',
    );
  });

  it('keeps the staging MCP database role read-only and outside normal migrations', () => {
    const roleSql = readFileSync(
      resolve(root, 'supabase/staging/001_clientops_mcp_reader.sql'),
      'utf8',
    );

    expect(roleSql).toContain('DO $clientops$');
    expect(roleSql).toContain('END\n$clientops$;');
    expect(roleSql).toContain('CREATE ROLE clientops_mcp_reader NOLOGIN');
    expect(roleSql).toContain('NOSUPERUSER');
    expect(roleSql).toContain('NOCREATEDB');
    expect(roleSql).toContain('NOCREATEROLE');
    expect(roleSql).toContain('NOREPLICATION');
    expect(roleSql).toContain('NOBYPASSRLS');
    expect(roleSql).toContain('GRANT SELECT ON TABLE');
    expect(roleSql).toContain('REVOKE CREATE ON SCHEMA public');
    expect(roleSql).toContain('action_proposals');
    expect(roleSql).toContain('action_approvals');
    expect(roleSql).toContain('action_executions');
    expect(roleSql).toContain('audit_events');

    const stagingSeed = readFileSync(
      resolve(root, 'supabase/staging/002_clientops_demo_seed.sql'),
      'utf8',
    );
    const executableSeed = stagingSeed.replace(/--.*$/gm, '');
    expect(executableSeed).not.toMatch(/\bTRUNCATE\b/i);
    expect(executableSeed).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executableSeed).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
    expect(executableSeed).toContain('ON CONFLICT DO NOTHING');

    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['db:reset']).toBe('tsx scripts/db.ts reset');
    expect(packageJson.scripts['demo:reset']).toBe(
      'tsx scripts/db.ts demo-reset',
    );
    expect(packageJson.scripts['staging:mcp:preflight']).toBe(
      'tsx scripts/staging-mcp-preflight.ts',
    );
  });
});
