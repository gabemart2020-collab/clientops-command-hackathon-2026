import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

interface SecretsManagerLike {
  send(command: GetSecretValueCommand): Promise<{
    SecretString?: string;
    SecretBinary?: Uint8Array;
  }>;
}

const SECRET_ARN =
  /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export async function hydrateAgentCoreDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  client?: SecretsManagerLike,
): Promise<boolean> {
  if (env.CLIENTOPS_MCP_RUNTIME?.trim() !== 'agentcore') return false;

  if (env.DATABASE_URL?.trim()) {
    throw new Error(
      'AgentCore database credential must come from Secrets Manager, not DATABASE_URL.',
    );
  }

  const secretArn = env.CLIENTOPS_DATABASE_URL_SECRET_ARN?.trim();
  if (!secretArn || !SECRET_ARN.test(secretArn)) {
    throw new Error(
      'AgentCore MCP mode requires a valid CLIENTOPS_DATABASE_URL_SECRET_ARN.',
    );
  }

  const region = env.AWS_REGION?.trim();
  if (!region) {
    throw new Error('AgentCore MCP mode requires AWS_REGION.');
  }

  const arnRegion = secretArn.split(':')[3];
  if (arnRegion !== region) {
    throw new Error(
      'AgentCore database secret must be in the same AWS region as the runtime.',
    );
  }

  const secrets = client ?? new SecretsManagerClient({ region });
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  const databaseUrl = response.SecretString?.trim();
  if (!databaseUrl) {
    throw new Error(
      'AgentCore database secret must contain a non-empty SecretString.',
    );
  }

  env.DATABASE_URL = databaseUrl;
  return true;
}

export function clearHydratedDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.CLIENTOPS_MCP_RUNTIME?.trim() === 'agentcore') {
    delete env.DATABASE_URL;
  }
}
