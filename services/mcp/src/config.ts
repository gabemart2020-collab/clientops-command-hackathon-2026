import { isIP } from 'node:net';
import * as z from 'zod';

export const MCP_PROTOCOL_BASELINE = '2025-11-25';

const hostname = z.string().refine((value) => {
  try {
    const url = new URL(`http://${value}`);
    return url.hostname === value && url.host === value && !value.includes('*');
  } catch {
    return false;
  }
}, 'Expected an explicit hostname without scheme or port');

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === value &&
      !value.includes('*')
    );
  } catch {
    return false;
  }
}, 'Expected an exact HTTP(S) origin without path or wildcard');

const configuration = z.object({
  runtimeMode: z.enum(['local', 'agentcore']),
  bindHost: z
    .string()
    .refine((value) => value === 'localhost' || isIP(value) !== 0),
  port: z.number().int().min(0).max(65535),
  allowedHosts: z.array(hostname),
  allowedOrigins: z.array(origin),
  environment: z.enum(['development', 'test', 'production']),
});

export type ServiceConfig = z.infer<typeof configuration>;

/** Reads only the explicit, non-secret service configuration. No .env loading. */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const list = (name: string, fallback: string[]) =>
    value(name)
      ?.split(',')
      .map((item) => item.trim()) ?? fallback;

  if (
    value('MCP_PROTOCOL_VERSION') &&
    value('MCP_PROTOCOL_VERSION') !== MCP_PROTOCOL_BASELINE
  ) {
    throw new Error('MCP_PROTOCOL_VERSION must match the competition baseline');
  }

  const runtimeMode = value('CLIENTOPS_MCP_RUNTIME') ?? 'local';
  if (runtimeMode !== 'local' && runtimeMode !== 'agentcore') {
    throw new Error('CLIENTOPS_MCP_RUNTIME must be "local" or "agentcore"');
  }

  if (runtimeMode === 'agentcore') {
    if (value('NODE_ENV') !== 'production') {
      throw new Error('AgentCore MCP mode requires NODE_ENV=production');
    }
    if (value('CLIENTOPS_DATABASE_TARGET') !== 'staging') {
      throw new Error(
        'AgentCore MCP mode requires CLIENTOPS_DATABASE_TARGET=staging',
      );
    }
    if (value('CLIENTOPS_DATABASE_WORKLOAD') !== 'mcp') {
      throw new Error(
        'AgentCore MCP mode requires CLIENTOPS_DATABASE_WORKLOAD=mcp',
      );
    }
    if (value('MCP_BIND_HOST') && value('MCP_BIND_HOST') !== '0.0.0.0') {
      throw new Error('AgentCore MCP mode requires MCP_BIND_HOST=0.0.0.0');
    }
    if (value('MCP_PORT') && value('MCP_PORT') !== '8000') {
      throw new Error('AgentCore MCP mode requires MCP_PORT=8000');
    }
    if (value('MCP_ALLOWED_ORIGINS')) {
      throw new Error(
        'AgentCore MCP mode does not permit browser Origin allowlists',
      );
    }

    return configuration.parse({
      runtimeMode,
      bindHost: '0.0.0.0',
      port: 8000,
      allowedHosts: [],
      allowedOrigins: [],
      environment: 'production',
    });
  }

  const port = Number(value('MCP_PORT') ?? 3001);
  return configuration.parse({
    runtimeMode,
    bindHost: value('MCP_BIND_HOST') ?? '127.0.0.1',
    port,
    allowedHosts: list('MCP_ALLOWED_HOSTS', [
      '127.0.0.1',
      'localhost',
      '[::1]',
    ]),
    allowedOrigins: list('MCP_ALLOWED_ORIGINS', [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:6274',
      'http://localhost:6274',
    ]),
    environment: value('NODE_ENV') ?? 'development',
  });
}
