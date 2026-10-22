import { McpServer } from '@modelcontextprotocol/server';
import { CLIENTOPS_TOOL_DEFINITIONS, TOOL_NAMES } from '@clientops/contracts';
import {
  ClientOpsService,
  DemoScenarioClock,
  DEMO_ORGANIZATION_ID,
  createTenantContext,
  type Clock,
  type TenantContext,
} from '@clientops/domain';
import {
  createPostgresDataStore,
  getDatabasePool,
  readDatabaseSafetyConfig,
  assertMcpReaderDatabasePrivileges,
} from '@clientops/data';
import { createProtocolServer } from './protocol.js';

export function getDefaultClientOpsService(
  clock: Clock = new DemoScenarioClock(),
): ClientOpsService {
  const pool = getDatabasePool();
  return new ClientOpsService(createPostgresDataStore(pool), clock);
}

export async function getConfiguredClientOpsService(
  clock: Clock = new DemoScenarioClock(),
): Promise<ClientOpsService> {
  const pool = getDatabasePool();
  const safety = readDatabaseSafetyConfig();

  if (safety.target === 'staging') {
    await assertMcpReaderDatabasePrivileges(pool);
  }

  return new ClientOpsService(createPostgresDataStore(pool), clock);
}

function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.toLowerCase().includes('not found')) {
    return 'Requested ClientOps record was not found.';
  }
  return 'ClientOps data retrieval failed.';
}

export function createClientOpsServer(
  tenant: TenantContext = createTenantContext(
    process.env.DEMO_ORGANIZATION_ID || DEMO_ORGANIZATION_ID,
  ),
  service: ClientOpsService = getDefaultClientOpsService(),
): McpServer {
  // Start with protocol base server containing system.get_status
  const server = createProtocolServer();

  // 1. account.get_context (READ)
  const accountDef = CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.ACCOUNT_GET_CONTEXT];
  server.registerTool(
    accountDef.name,
    {
      description: accountDef.description,
      inputSchema: accountDef.inputSchema,
      outputSchema: accountDef.outputSchema,
      annotations: {
        readOnlyHint: accountDef.readOnly,
        destructiveHint: false,
        idempotentHint: accountDef.idempotent,
        openWorldHint: false,
      },
    },
    async ({ account_ref }) => {
      try {
        const result = await service.getAccountContext(tenant, account_ref);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: safeToolError(error) }],
        };
      }
    },
  );

  // 2. activity.get_recent (READ)
  const activityDef =
    CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.ACTIVITY_GET_RECENT];
  server.registerTool(
    activityDef.name,
    {
      description: activityDef.description,
      inputSchema: activityDef.inputSchema,
      outputSchema: activityDef.outputSchema,
      annotations: {
        readOnlyHint: activityDef.readOnly,
        destructiveHint: false,
        idempotentHint: activityDef.idempotent,
        openWorldHint: false,
      },
    },
    async ({ client_id, lookback_days }) => {
      try {
        const result = await service.getRecentActivity(
          tenant,
          client_id,
          lookback_days,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: safeToolError(error) }],
        };
      }
    },
  );

  // 3. commitment.list_open (READ)
  const commitmentDef =
    CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.COMMITMENT_LIST_OPEN];
  server.registerTool(
    commitmentDef.name,
    {
      description: commitmentDef.description,
      inputSchema: commitmentDef.inputSchema,
      outputSchema: commitmentDef.outputSchema,
      annotations: {
        readOnlyHint: commitmentDef.readOnly,
        destructiveHint: false,
        idempotentHint: commitmentDef.idempotent,
        openWorldHint: false,
      },
    },
    async ({ client_id }) => {
      try {
        const result = await service.listOpenCommitments(tenant, client_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: safeToolError(error) }],
        };
      }
    },
  );

  // 4. project.assess_delivery_health (ANALYZE)
  const healthDef =
    CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH];
  server.registerTool(
    healthDef.name,
    {
      description: healthDef.description,
      inputSchema: healthDef.inputSchema,
      outputSchema: healthDef.outputSchema,
      annotations: {
        readOnlyHint: healthDef.readOnly,
        destructiveHint: false,
        idempotentHint: healthDef.idempotent,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        const result = await service.assessDeliveryHealth(tenant, project_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: safeToolError(error) }],
        };
      }
    },
  );

  // 5. meeting.prepare_brief (ANALYZE)
  const briefDef = CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.MEETING_PREPARE_BRIEF];
  server.registerTool(
    briefDef.name,
    {
      description: briefDef.description,
      inputSchema: briefDef.inputSchema,
      outputSchema: briefDef.outputSchema,
      annotations: {
        readOnlyHint: briefDef.readOnly,
        destructiveHint: false,
        idempotentHint: briefDef.idempotent,
        openWorldHint: false,
      },
    },
    async ({ meeting_id }) => {
      try {
        const result = await service.prepareBrief(tenant, meeting_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: safeToolError(error) }],
        };
      }
    },
  );

  return server;
}
