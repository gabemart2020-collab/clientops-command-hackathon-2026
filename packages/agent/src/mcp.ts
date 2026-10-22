import { McpClient, type Tool } from '@strands-agents/sdk';
import { TOOL_NAMES } from '@clientops/contracts';

/**
 * Strict allowlist of tools authorized for the Phase 3 ClientOps operations agent.
 *
 * Any tools not on this list (including system.get_status and any future Phase 4 WRITE tools)
 * must NEVER be exposed to the agent loop or model reasoning.
 */
export const AUTHORIZED_AGENT_TOOLS = [
  TOOL_NAMES.ACCOUNT_GET_CONTEXT,
  TOOL_NAMES.ACTIVITY_GET_RECENT,
  TOOL_NAMES.COMMITMENT_LIST_OPEN,
  TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
  TOOL_NAMES.MEETING_PREPARE_BRIEF,
] as const;

export const AUTHORIZED_NORMALIZED_TOOL_NAMES = [
  'account_get_context',
  'activity_get_recent',
  'commitment_list_open',
  'project_assess_delivery_health',
  'meeting_prepare_brief',
] as const;

export type AuthorizedToolName = (typeof AUTHORIZED_AGENT_TOOLS)[number];
export type AuthorizedNormalizedToolName =
  (typeof AUTHORIZED_NORMALIZED_TOOL_NAMES)[number];

export function normalizeToolName(name: string): string {
  return name.replaceAll('.', '_');
}

export function isToolAuthorized(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return AUTHORIZED_NORMALIZED_TOOL_NAMES.includes(
    normalized as AuthorizedNormalizedToolName,
  );
}

export function assertToolAuthorized(toolName: string): void {
  if (!isToolAuthorized(toolName)) {
    throw new Error(
      `UNAUTHORIZED_TOOL_ACCESS: Tool "${toolName}" is not in the ClientOps agent allowlist. Access denied.`,
    );
  }
}

/**
 * Creates an McpClient configured with native Streamable HTTP and strict tool allowlist filtering.
 */
export function createClientOpsMcpClient(mcpUrl: string): McpClient {
  return new McpClient({
    url: mcpUrl,
    toolFilters: {
      allowed: [...AUTHORIZED_AGENT_TOOLS, ...AUTHORIZED_NORMALIZED_TOOL_NAMES],
    },
  });
}

/**
 * Discovers tools from the MCP server, filters them against the strict allowlist,
 * and normalizes tool names to satisfy Bedrock Converse API and Strands regex /^[a-zA-Z0-9_-]+$/.
 */
export async function loadAuthorizedMcpTools(
  mcpClient: McpClient,
): Promise<Tool[]> {
  const serverTools = await mcpClient.listTools();
  const authorizedTools: Tool[] = [];

  for (const tool of serverTools) {
    if (isToolAuthorized(tool.name)) {
      // Normalize name from dot notation to underscore for Bedrock Converse API compatibility
      const normalized = normalizeToolName(tool.name);
      Object.defineProperty(tool, 'name', {
        value: normalized,
        writable: true,
        configurable: true,
      });
      if (tool.toolSpec) {
        tool.toolSpec.name = normalized;
      }
      authorizedTools.push(tool);
    }
  }

  return authorizedTools;
}
