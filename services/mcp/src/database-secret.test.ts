import { describe, expect, it } from 'vitest';
import {
  clearHydratedDatabaseUrl,
  hydrateAgentCoreDatabaseUrl,
} from './database-secret.js';

const secretArn =
  'arn:aws:secretsmanager:us-east-1:111122223333:secret:clientops/staging/database-url-AbCdEf';

describe('AgentCore database secret hydration', () => {
  it('does nothing outside AgentCore mode', async () => {
    const env = { CLIENTOPS_MCP_RUNTIME: 'local' };
    await expect(hydrateAgentCoreDatabaseUrl(env)).resolves.toBe(false);
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('rejects a plaintext AgentCore DATABASE_URL', async () => {
    await expect(
      hydrateAgentCoreDatabaseUrl({
        CLIENTOPS_MCP_RUNTIME: 'agentcore',
        AWS_REGION: 'us-east-1',
        CLIENTOPS_DATABASE_URL_SECRET_ARN: secretArn,
        DATABASE_URL: 'postgresql://should-not-be-in-runtime-config',
      }),
    ).rejects.toThrow(/Secrets Manager, not DATABASE_URL/);
  });

  it('requires a same-region Secrets Manager ARN', async () => {
    await expect(
      hydrateAgentCoreDatabaseUrl({
        CLIENTOPS_MCP_RUNTIME: 'agentcore',
        AWS_REGION: 'us-east-1',
      }),
    ).rejects.toThrow(/CLIENTOPS_DATABASE_URL_SECRET_ARN/);

    await expect(
      hydrateAgentCoreDatabaseUrl({
        CLIENTOPS_MCP_RUNTIME: 'agentcore',
        AWS_REGION: 'us-east-1',
        CLIENTOPS_DATABASE_URL_SECRET_ARN:
          'arn:aws:secretsmanager:us-west-2:111122223333:secret:clientops/staging/database-url-AbCdEf',
      }),
    ).rejects.toThrow(/same AWS region/);
  });

  it('hydrates SecretString without logging or reshaping it', async () => {
    const databaseUrl =
      'postgresql://reader:secret@db.example:5432/postgres?sslmode=verify-full';
    const env: NodeJS.ProcessEnv = {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      AWS_REGION: 'us-east-1',
      CLIENTOPS_DATABASE_URL_SECRET_ARN: secretArn,
    };
    const client = {
      async send() {
        return { SecretString: databaseUrl };
      },
    };

    await expect(hydrateAgentCoreDatabaseUrl(env, client)).resolves.toBe(true);
    expect(env.DATABASE_URL).toBe(databaseUrl);

    clearHydratedDatabaseUrl(env);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('rejects empty or binary-only secret values', async () => {
    const env: NodeJS.ProcessEnv = {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      AWS_REGION: 'us-east-1',
      CLIENTOPS_DATABASE_URL_SECRET_ARN: secretArn,
    };

    await expect(
      hydrateAgentCoreDatabaseUrl(env, {
        async send() {
          return { SecretBinary: new Uint8Array([1, 2, 3]) };
        },
      }),
    ).rejects.toThrow(/non-empty SecretString/);
  });
});
