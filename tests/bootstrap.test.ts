import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const workspaces = [
  'apps/web',
  'services/mcp',
  'services/agent-runtime',
  ...[
    'agent',
    'contracts',
    'domain',
    'policy',
    'data',
    'audit',
    'evaluation',
    'ui',
  ].map((name) => `packages/${name}`),
];

describe('repository bootstrap', () => {
  it.each(workspaces)(
    '%s is a private, independently typechecked workspace',
    (path) => {
      const manifest = JSON.parse(read(`${path}/package.json`));
      expect(manifest.private).toBe(true);
      expect(manifest.name).toBe(`@clientops/${path.split('/').at(-1)}`);
      expect(manifest.scripts.typecheck).toBe('tsc --noEmit');
      expect(existsSync(resolve(root, path, 'tsconfig.json'))).toBe(true);
    },
  );

  it('includes the required governance and planning documents', () => {
    const required = [
      'AGENTS.md',
      'apps/web/AGENTS.md',
      'services/mcp/AGENTS.md',
      'services/agent-runtime/AGENTS.md',
      ...[
        'HACKATHON_REQUIREMENTS',
        'PRODUCT',
        'ARCHITECTURE',
        'MCP_PROTOCOL',
        'TOOL_CONTRACTS',
        'DATA_MODEL',
        'SECURITY',
        'EVALUATION',
        'DEMO',
        'FRICTION_LOG',
        'IMPLEMENTATION_PLAN',
        'SUBMISSION',
        'PHASE5_CONTRACTS',
        'PHASE5_1_RUNBOOK',
        'PHASE5_2_RUNBOOK',
      ].map((name) => `docs/${name}.md`),
      ...[
        '0001-typescript-monorepo',
        '0002-stateless-mcp',
        '0003-human-approval-boundary',
        '0004-domain-truth-vs-agent-memory',
        '0005-controlled-action-approval',
        '0006-agentcore-runtime-memory-boundaries',
      ].map((name) => `docs/adr/${name}.md`),
    ];
    for (const path of required)
      expect(read(path).trim().length).toBeGreaterThan(100);
  });

  it('provides every planned environment variable without populated credentials', () => {
    const entries = read('.env.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('='));
    const environment = Object.fromEntries(entries);
    expect(Object.keys(environment).sort()).toEqual(
      [
        'NODE_ENV',
        'NEXT_PUBLIC_SUPABASE_URL',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'AWS_REGION',
        'BEDROCK_MODEL_ID',
        'CLIENTOPS_AGENT_DATABASE_URL_SECRET_ARN',
        'CLIENTOPS_AGENT_MAX_BODY_BYTES',
        'CLIENTOPS_AGENT_MCP_QUALIFIER',
        'CLIENTOPS_AGENT_MCP_RUNTIME_ARN',
        'CLIENTOPS_CERTIFICATION_ACTOR_ID',
        'CLIENTOPS_CERTIFICATION_ORGANIZATION_ID',
        'CLIENTOPS_MCP_URL',
        'MCP_PROTOCOL_VERSION',
        'MCP_ALLOWED_ORIGINS',
        'MCP_ALLOWED_HOSTS',
        'MCP_BIND_HOST',
        'MCP_PORT',
        'AGENTCORE_RUNTIME_ARN',
        'AGENTCORE_RUNTIME_ENDPOINT',
        'DEMO_ORGANIZATION_ID',
        'DEMO_USER_ID',
        'DATABASE_URL',
        'CLIENTOPS_DATABASE_TARGET',
        'CLIENTOPS_DATABASE_WORKLOAD',
        'CLIENTOPS_ENVIRONMENT',
        'CLIENTOPS_STAGING_DB_HOST',
        'CLIENTOPS_STAGING_DB_NAME',
        'CLIENTOPS_STAGING_DB_USER',
        'CLIENTOPS_STAGING_DB_CA_FILE',
        'CLIENTOPS_DATABASE_URL_SECRET_ARN',
        'CLIENTOPS_MCP_RUNTIME',
        'CLIENTOPS_WEB_ACTION_WRITES_ENABLED',
        'CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR',
        'AGENT_MAX_TOTAL_TOKENS',
        'AGENT_MAX_OUTPUT_TOKENS',
        'AGENT_MAX_TURNS',
        'AGENT_TIMEOUT_MS',
      ].sort(),
    );
    expect(entries).toHaveLength(38);

    const allowedDefaults: Record<string, string> = {
      MCP_PROTOCOL_VERSION: '2025-11-25',
      CLIENTOPS_DATABASE_TARGET: 'local',
      CLIENTOPS_MCP_RUNTIME: 'local',
      CLIENTOPS_WEB_ACTION_WRITES_ENABLED: 'false',
      CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR: 'false',
      AGENT_MAX_TOTAL_TOKENS: '32000',
      AGENT_MAX_OUTPUT_TOKENS: '2000',
      AGENT_MAX_TURNS: '6',
      AGENT_TIMEOUT_MS: '30000',
    };

    for (const [name, value] of entries) {
      expect(name).toBeTruthy();
      if (!name) continue;
      expect(value).toBe(allowedDefaults[name] ?? '');
    }
  });
});
