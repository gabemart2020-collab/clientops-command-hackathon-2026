import { startClientOpsService } from './index.js';
import {
  clearHydratedDatabaseUrl,
  hydrateAgentCoreDatabaseUrl,
} from './database-secret.js';

try {
  const hydratedDatabaseUrl = await hydrateAgentCoreDatabaseUrl();
  const service = await startClientOpsService();
  if (hydratedDatabaseUrl) clearHydratedDatabaseUrl();
  console.log(`ClientOps MCP service listening at ${service.url}/mcp`);
  const shutdown = async () => {
    await service.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  clearHydratedDatabaseUrl();
  console.error(
    'MCP startup failed. Check the documented runtime, database, and port configuration.',
  );
  process.exitCode = 1;
}
