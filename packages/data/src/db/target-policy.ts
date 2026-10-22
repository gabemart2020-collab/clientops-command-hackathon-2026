export type DatabaseTarget = 'local' | 'staging';

export type DatabaseSafetyConfig =
  | { target: 'local' }
  | {
      target: 'staging';
      environment: 'staging';
      workload: 'mcp' | 'agent-proposer';
      stagingHost: string;
      stagingDatabase: string;
      stagingUser: string;
    };

const LOCAL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  'postgres',
]);
const SAFE_LOCAL_DATABASE_PATTERNS = ['dev', 'test', 'local', 'clientops'];
const REQUIRED_STAGING_SSL_MODE = 'verify-full';

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parsePostgresUrl(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      'Database safety check failed: Invalid connection string URL.',
    );
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(
      'Database safety check failed: connection string must use postgres:// or postgresql://.',
    );
  }

  return url;
}

export function readDatabaseSafetyConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseSafetyConfig {
  const target = envValue(env, 'CLIENTOPS_DATABASE_TARGET') ?? 'local';

  if (target === 'local') return { target: 'local' };

  if (target !== 'staging') {
    throw new Error(
      'CLIENTOPS_DATABASE_TARGET must be exactly "local" or "staging".',
    );
  }

  if (envValue(env, 'CLIENTOPS_ENVIRONMENT') !== 'staging') {
    throw new Error(
      'Staging database access requires CLIENTOPS_ENVIRONMENT=staging.',
    );
  }

  const workload = envValue(env, 'CLIENTOPS_DATABASE_WORKLOAD');
  if (workload !== 'mcp' && workload !== 'agent-proposer') {
    throw new Error(
      'Staging database access requires CLIENTOPS_DATABASE_WORKLOAD=mcp or CLIENTOPS_DATABASE_WORKLOAD=agent-proposer.',
    );
  }

  const stagingHost = envValue(env, 'CLIENTOPS_STAGING_DB_HOST');
  const stagingDatabase = envValue(env, 'CLIENTOPS_STAGING_DB_NAME');
  const stagingUser = envValue(env, 'CLIENTOPS_STAGING_DB_USER');

  if (!stagingHost || stagingHost.includes('*') || stagingHost.includes('/')) {
    throw new Error(
      'Staging database access requires an exact CLIENTOPS_STAGING_DB_HOST allowlist value.',
    );
  }

  if (
    !stagingDatabase ||
    stagingDatabase.includes('/') ||
    stagingDatabase.includes('*')
  ) {
    throw new Error(
      'Staging database access requires an exact CLIENTOPS_STAGING_DB_NAME allowlist value.',
    );
  }

  if (!stagingUser || stagingUser.includes('*') || stagingUser.includes('/')) {
    throw new Error(
      'Staging database access requires an exact CLIENTOPS_STAGING_DB_USER allowlist value.',
    );
  }

  return {
    target: 'staging',
    environment: 'staging',
    workload,
    stagingHost: stagingHost.toLowerCase(),
    stagingDatabase,
    stagingUser,
  };
}

/**
 * Local mode permits only loopback/container hosts and obviously non-production
 * database names.
 */
export function assertLocalDatabaseTarget(connectionString: string): void {
  const url = parsePostgresUrl(connectionString);
  const hostname = url.hostname.toLowerCase();

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Database safety violation: attempted connection to non-local host "${hostname}". Only local dev/test database hosts are permitted in local mode.`,
    );
  }

  const databaseName = decodeURIComponent(
    url.pathname.replace(/^\//, ''),
  ).toLowerCase();
  const safe = SAFE_LOCAL_DATABASE_PATTERNS.some((pattern) =>
    databaseName.includes(pattern),
  );

  if (!safe) {
    throw new Error(
      `Database safety violation: database name "${databaseName}" does not match safe dev/test patterns (dev, test, local, clientops).`,
    );
  }
}

/**
 * Staging mode is intentionally narrow: exact host, exact database name,
 * exact database user, explicit staging environment, and TLS are mandatory.
 */
export function assertStagingDatabaseTarget(
  connectionString: string,
  config: Extract<DatabaseSafetyConfig, { target: 'staging' }>,
): void {
  const url = parsePostgresUrl(connectionString);
  const hostname = url.hostname.toLowerCase();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const username = decodeURIComponent(url.username);
  const sslMode = url.searchParams.get('sslmode')?.toLowerCase();

  for (const overrideName of ['sslcert', 'sslkey', 'sslrootcert']) {
    if (url.searchParams.has(overrideName)) {
      throw new Error(
        'Database safety violation: staging TLS file options are not permitted in DATABASE_URL.',
      );
    }
  }

  if (LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      'Database safety violation: staging mode requires the exact configured remote staging host.',
    );
  }

  if (hostname !== config.stagingHost) {
    throw new Error(
      'Database safety violation: staging host does not match the exact configured allowlist.',
    );
  }

  if (databaseName !== config.stagingDatabase) {
    throw new Error(
      'Database safety violation: staging database name does not match the exact configured allowlist.',
    );
  }

  if (username !== config.stagingUser) {
    throw new Error(
      'Database safety violation: staging database user does not match the exact configured allowlist.',
    );
  }

  if (sslMode !== REQUIRED_STAGING_SSL_MODE) {
    throw new Error(
      'Database safety violation: staging PostgreSQL requires sslmode=verify-full.',
    );
  }
}

export function assertConfiguredDatabaseTarget(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseSafetyConfig {
  const config = readDatabaseSafetyConfig(env);

  if (config.target === 'local') {
    assertLocalDatabaseTarget(connectionString);
  } else {
    assertStagingDatabaseTarget(connectionString, config);
  }

  return config;
}

/**
 * node-postgres replaces an explicit `ssl` object when `sslmode` is present
 * in a connection string. After the policy has required/validated sslmode,
 * remove only that query option so Pool can enforce verified TLS explicitly.
 */
export function connectionStringForVerifiedStagingTls(
  connectionString: string,
): string {
  const url = parsePostgresUrl(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}
