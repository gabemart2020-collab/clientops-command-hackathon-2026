import {
  assertAgentProposerDatabasePrivileges,
  closeDatabasePool,
  getDatabasePool,
  readDatabaseSafetyConfig,
} from '../packages/data/src/index.js';

async function main(): Promise<void> {
  const config = readDatabaseSafetyConfig();

  if (config.target !== 'staging' || config.workload !== 'agent-proposer') {
    throw new Error(
      'Staging Agent proposer preflight requires CLIENTOPS_DATABASE_TARGET=staging and CLIENTOPS_DATABASE_WORKLOAD=agent-proposer.',
    );
  }

  const pool = getDatabasePool();

  try {
    const report = await assertAgentProposerDatabasePrivileges(pool);
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          target: 'staging',
          workload: 'agent-proposer',
          proposerRoleMember: report.proposerRoleMember,
          schemaUsage: report.schemaUsage,
          schemaCreate: report.schemaCreate,
          readableTables: report.readableTables,
          forbiddenReadTables: report.forbiddenReadTables,
          protectedTables: report.protectedTables,
          proposalInsertColumns: report.proposalInsertColumns,
          proposalUpdateColumns: report.proposalUpdateColumns,
          auditInsertColumns: report.auditInsertColumns,
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
  console.error('Agent proposer staging database preflight failed.', {
    errorType,
  });
  process.exitCode = 1;
});
