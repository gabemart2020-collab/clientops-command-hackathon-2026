import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import {
  assertConfiguredDatabaseTarget,
  connectionStringForVerifiedStagingTls,
  readDatabaseSafetyConfig,
  type DatabaseSafetyConfig,
} from './target-policy.js';

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

const DEFAULT_LOCAL_URL =
  'postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev';

let activePool: pg.Pool | null = null;
let activePoolKey: string | null = null;

const MAX_STAGING_CA_FILE_BYTES = 32768;

export function readStagingDatabaseCa(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const caFile = env.CLIENTOPS_STAGING_DB_CA_FILE?.trim();

  if (!caFile || !isAbsolute(caFile)) {
    throw new Error(
      'Staging database access requires an absolute CLIENTOPS_STAGING_DB_CA_FILE path.',
    );
  }

  let ca: string;
  try {
    const size = statSync(caFile).size;
    if (size <= 0 || size > MAX_STAGING_CA_FILE_BYTES) {
      throw new Error('invalid certificate size');
    }
    ca = readFileSync(caFile, 'utf8').trim();
  } catch {
    throw new Error(
      'Staging database CA file is unavailable or outside the allowed size bound.',
    );
  }

  if (
    !ca.startsWith('-----BEGIN CERTIFICATE-----') ||
    !ca.endsWith('-----END CERTIFICATE-----')
  ) {
    throw new Error('Staging database CA file must contain a PEM certificate.');
  }

  return `${ca}\n`;
}

function databasePoolKey(
  connectionString: string,
  safety: DatabaseSafetyConfig,
): string {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const username = decodeURIComponent(url.username);
  return [
    safety.target,
    url.hostname.toLowerCase(),
    url.port || '5432',
    databaseName,
    username,
  ].join(':');
}

export function getDatabasePool(
  customUrl?: string,
  configOverrides?: pg.PoolConfig,
  env: NodeJS.ProcessEnv = process.env,
): pg.Pool {
  const requestedSafety = readDatabaseSafetyConfig(env);
  let connectionString: string;

  if (customUrl) {
    connectionString = customUrl;
  } else if (requestedSafety.target === 'staging') {
    const stagingDatabaseUrl = env.DATABASE_URL?.trim();
    if (!stagingDatabaseUrl) {
      throw new Error(
        'Staging database access requires DATABASE_URL; SUPABASE_DB_URL fallback is disabled.',
      );
    }
    connectionString = stagingDatabaseUrl;
  } else {
    connectionString =
      env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? DEFAULT_LOCAL_URL;
  }

  const safety: DatabaseSafetyConfig = assertConfiguredDatabaseTarget(
    connectionString,
    env,
  );

  const poolKey = databasePoolKey(connectionString, safety);

  if (activePool) {
    if (activePoolKey !== poolKey) {
      throw new Error(
        'Database pool is already initialized for a different validated target.',
      );
    }
    return activePool;
  }

  const poolConnectionString =
    safety.target === 'staging'
      ? connectionStringForVerifiedStagingTls(connectionString)
      : connectionString;
  const stagingCa =
    safety.target === 'staging' ? readStagingDatabaseCa(env) : undefined;

  activePool = new Pool({
    ...configOverrides,
    connectionString: poolConnectionString,
    max: configOverrides?.max ?? 10,
    idleTimeoutMillis: configOverrides?.idleTimeoutMillis ?? 10000,
    connectionTimeoutMillis: configOverrides?.connectionTimeoutMillis ?? 5000,
    ...(safety.target === 'staging'
      ? { ssl: { rejectUnauthorized: true, ca: stagingCa } }
      : {}),
  });
  activePoolKey = poolKey;

  return activePool;
}

export async function closeDatabasePool(): Promise<void> {
  if (activePool) {
    await activePool.end();
    activePool = null;
    activePoolKey = null;
  }
}
