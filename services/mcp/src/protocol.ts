import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import manifest from '../package.json' with { type: 'json' };
import { MCP_PROTOCOL_BASELINE } from './config.js';

export const SERVICE = 'clientops-mcp';
export const VERSION = manifest.version;
export const STATUS_TOOL = 'system.get_status';
export const statusSchema = z.strictObject({
  service: z.literal(SERVICE),
  version: z.literal(VERSION),
  status: z.literal('ok'),
  mcpProtocolBaseline: z.literal(MCP_PROTOCOL_BASELINE),
  runtime: z.literal('nodejs-24'),
});

export function createProtocolServer() {
  const server = new McpServer({ name: SERVICE, version: VERSION });
  server.registerTool(
    STATUS_TOOL,
    {
      description:
        'Read the local MCP protocol-proof service status. No business data or side effects.',
      inputSchema: z.strictObject({}),
      outputSchema: statusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = statusSchema.parse({
        service: SERVICE,
        version: VERSION,
        status: 'ok',
        mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
        runtime: 'nodejs-24',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
  return server;
}
