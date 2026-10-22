import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, type GetAccountContextOutput } from '@clientops/contracts';
import {
  AgentCoreMcpAdapter,
  AgentCoreMcpProtocolError,
  parseSingleAgentCoreSseMessage,
  type AgentCoreRuntimeInvocation,
  type AgentCoreRuntimeInvocationResult,
  type AgentCoreRuntimeInvoker,
} from './agentcore-mcp.js';
import { parseAgentRuntimeServiceConfig } from './config.js';

const config = parseAgentRuntimeServiceConfig({
  host: '0.0.0.0',
  port: 8080,
  awsRegion: 'us-east-1',
  modelId: 'us.anthropic.claude-sonnet-4-6',
  mcpRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/clientops_mcp_example-EXAMPLE123',
  mcpQualifier: 'DEFAULT',
  certificationOrganizationId: '10000000-0000-4000-8000-000000000001',
  certificationActorId: '10000000-0000-4000-8000-000000000011',
  maxBodyBytes: 65_536,
  maxTurns: 6,
  maxOutputTokens: 2000,
  maxTotalTokens: 12_000,
  timeoutMs: 30_000,
  temperature: 0.1,
});

function sse(value: unknown): string {
  return `event: message\ndata: ${JSON.stringify(value)}\n\n`;
}

class FakeInvoker implements AgentCoreRuntimeInvoker {
  public readonly requests: AgentCoreRuntimeInvocation[] = [];

  constructor(
    private readonly responder: (
      request: AgentCoreRuntimeInvocation,
    ) => AgentCoreRuntimeInvocationResult,
  ) {}

  async invoke(
    request: AgentCoreRuntimeInvocation,
  ): Promise<AgentCoreRuntimeInvocationResult> {
    this.requests.push(request);
    return this.responder(request);
  }
}

const exactCatalog = [
  'system.get_status',
  TOOL_NAMES.ACCOUNT_GET_CONTEXT,
  TOOL_NAMES.ACTIVITY_GET_RECENT,
  TOOL_NAMES.COMMITMENT_LIST_OPEN,
  TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
  TOOL_NAMES.MEETING_PREPARE_BRIEF,
].map((name) => ({
  name,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));

describe('Phase 5.2.1 AgentCore MCP adapter', () => {
  it('parses exactly one AgentCore message SSE envelope', () => {
    expect(
      parseSingleAgentCoreSseMessage(
        sse({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      ),
    ).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(() =>
      parseSingleAgentCoreSseMessage(
        sse({ jsonrpc: '2.0', id: 1, result: {} }) +
          sse({ jsonrpc: '2.0', id: 2, result: {} }),
      ),
    ).toThrow(AgentCoreMcpProtocolError);
  });

  it('fails closed if a certified tool loses read-only annotations', async () => {
    const unsafeCatalog = exactCatalog.map((tool, index) =>
      index === 1
        ? {
            ...tool,
            annotations: {
              ...tool.annotations,
              readOnlyHint: false,
            },
          }
        : tool,
    );
    const invoker = new FakeInvoker(() => ({
      statusCode: 200,
      contentType: 'text/event-stream',
      response: sse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: unsafeCatalog },
      }),
    }));
    const adapter = new AgentCoreMcpAdapter(config, invoker);

    await expect(adapter.assertCertifiedCatalog()).rejects.toThrow();
  });

  it('fails closed if the remote catalog contains any unexpected tool', async () => {
    const invoker = new FakeInvoker(() => ({
      statusCode: 200,
      contentType: 'text/event-stream',
      response: sse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            ...exactCatalog,
            {
              name: 'task.create',
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
          ],
        },
      }),
    }));
    const adapter = new AgentCoreMcpAdapter(config, invoker);

    await expect(adapter.assertCertifiedCatalog()).rejects.toThrow(
      /certified six-tool catalog/,
    );
  });

  it('exposes exactly five normalized model tools after exact catalog discovery', async () => {
    const invoker = new FakeInvoker(() => ({
      statusCode: 200,
      contentType: 'text/event-stream',
      response: sse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: exactCatalog },
      }),
    }));
    const adapter = new AgentCoreMcpAdapter(config, invoker);
    const tools = await adapter.createModelTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'account_get_context',
        'activity_get_recent',
        'commitment_list_open',
        'meeting_prepare_brief',
        'project_assess_delivery_health',
      ].sort(),
    );
    expect(tools.map((tool) => tool.name)).not.toContain('system_get_status');
  });

  it('validates tool input and returns validated structured content', async () => {
    const accountOutput: GetAccountContextOutput = {
      client: {
        id: 'c0000000-0000-4000-8000-000000000001',
        name: 'Acme Labs',
        slug: 'acme-labs',
        industry: 'Enterprise Biotechnology',
        tier: 'enterprise',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      activeProjects: [],
      upcomingMeetings: [],
      counts: {
        openTasks: 0,
        completedTasks: 0,
        openMilestones: 0,
        overdueMilestones: 0,
        openCommitments: 0,
      },
      openCommitments: [],
    };

    const invoker = new FakeInvoker((request) => {
      expect(request.mcpProtocolVersion).toBe('2025-11-25');
      expect(request.mcpMethod).toBe('tools/call');
      expect(request.mcpName).toBe(TOOL_NAMES.ACCOUNT_GET_CONTEXT);
      return {
        statusCode: 200,
        contentType: 'text/event-stream',
        response: sse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            structuredContent: accountOutput,
          },
        }),
      };
    });
    const adapter = new AgentCoreMcpAdapter(config, invoker);

    await expect(
      adapter.callRemoteTool(TOOL_NAMES.ACCOUNT_GET_CONTEXT, {
        account_ref: 'acme-labs',
      }),
    ).resolves.toEqual(accountOutput);

    await expect(
      adapter.callRemoteTool(TOOL_NAMES.ACCOUNT_GET_CONTEXT, {}),
    ).rejects.toThrow();
  });
});
