import {
  assertMcpReaderDatabasePrivileges,
  closeDatabasePool,
  getDatabasePool,
  readDatabaseSafetyConfig,
} from '../packages/data/src/index.js';

async function main(): Promise<void> {
  const config = readDatabaseSafetyConfig();

  if (config.target !== 'staging') {
    throw new Error(
      'Staging MCP preflight requires CLIENTOPS_DATABASE_TARGET=staging.',
    );
  }

  const pool = getDatabasePool();

  try {
    const report = await assertMcpReaderDatabasePrivileges(pool);
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          target: 'staging',
          readerRoleMember: report.readerRoleMember,
          schemaUsage: report.schemaUsage,
          schemaCreate: report.schemaCreate,
          readableTables: report.readableTables,
          protectedTables: report.protectedTables,
          forbiddenReadTables: report.forbiddenReadTables,
          otherRoleMemberships: report.otherRoleMemberships,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDatabasePool();
  }
}

void main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  console.error('MCP staging database preflight failed.', { errorType });
  process.exitCode = 1;
});
