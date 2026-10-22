import { FunctionTool } from '@strands-agents/sdk';
import { z } from 'zod';
import { CLIENTOPS_TOOL_DEFINITIONS, TOOL_NAMES } from '@clientops/contracts';
import { normalizeToolName } from '@clientops/agent';
import type { AgentRuntimeServiceConfig } from './config.js';

export interface AgentCoreRuntimeInvocation {
  agentRuntimeArn: string;
  qualifier: string;
  contentType: 'application/json';
  accept: 'application/json, text/event-stream';
  mcpProtocolVersion: '2025-11-25';
  mcpMethod: 'tools/list' | 'tools/call';
  mcpName?: string;
  payload: string;
}

export interface AgentCoreRuntimeInvocationResult {
  statusCode?: number;
  contentType?: string;
  response: string;
}

export interface AgentCoreRuntimeInvoker {
  invoke(
    request: AgentCoreRuntimeInvocation,
  ): Promise<AgentCoreRuntimeInvocationResult>;
}

const EXPECTED_REMOTE_TOOL_NAMES = [
  'system.get_status',
  TOOL_NAMES.ACCOUNT_GET_CONTEXT,
  TOOL_NAMES.ACTIVITY_GET_RECENT,
  TOOL_NAMES.COMMITMENT_LIST_OPEN,
  TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
  TOOL_NAMES.MEETING_PREPARE_BRIEF,
] as const;

const RpcEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ToolListResultSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          annotations: z
            .object({
              readOnlyHint: z.literal(true),
              destructiveHint: z.literal(false),
              idempotentHint: z.literal(true),
              openWorldHint: z.literal(false),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const ToolCallResultSchema = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export class AgentCoreMcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCoreMcpProtocolError';
  }
}

export function parseSingleAgentCoreSseMessage(body: string): unknown {
  const blocks = body
    .replaceAll('\r\n', '\n')
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const messagePayloads: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    if (event !== 'message') {
      continue;
    }
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      throw new AgentCoreMcpProtocolError(
        'AgentCore MCP response contained an empty message event.',
      );
    }
    messagePayloads.push(data);
  }

  if (messagePayloads.length !== 1) {
    throw new AgentCoreMcpProtocolError(
      'AgentCore MCP response must contain exactly one message event.',
    );
  }

  try {
    return JSON.parse(messagePayloads[0] ?? '');
  } catch {
    throw new AgentCoreMcpProtocolError(
      'AgentCore MCP response contained invalid JSON.',
    );
  }
}

function parseRpcResult(body: string): unknown {
  const envelope = RpcEnvelopeSchema.parse(
    parseSingleAgentCoreSseMessage(body),
  );
  if (envelope.error || envelope.result === undefined) {
    throw new AgentCoreMcpProtocolError(
      'AgentCore MCP returned a bounded JSON-RPC error.',
    );
  }
  return envelope.result;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export class AgentCoreMcpAdapter {
  private nextId = 1;

  constructor(
    private readonly config: AgentRuntimeServiceConfig,
    private readonly invoker: AgentCoreRuntimeInvoker,
  ) {}

  private async invokeRpc(
    method: 'tools/list' | 'tools/call',
    params: Record<string, unknown>,
    mcpName?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.invoker.invoke({
      agentRuntimeArn: this.config.mcpRuntimeArn,
      qualifier: this.config.mcpQualifier,
      contentType: 'application/json',
      accept: 'application/json, text/event-stream',
      mcpProtocolVersion: '2025-11-25',
      mcpMethod: method,
      ...(mcpName ? { mcpName } : {}),
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    });

    if (response.statusCode !== undefined && response.statusCode !== 200) {
      throw new AgentCoreMcpProtocolError(
        'AgentCore MCP invocation returned a non-success status.',
      );
    }
    if (
      response.contentType &&
      !response.contentType.toLowerCase().includes('text/event-stream')
    ) {
      throw new AgentCoreMcpProtocolError(
        'AgentCore MCP invocation returned an unexpected content type.',
      );
    }

    return parseRpcResult(response.response);
  }

  public async assertCertifiedCatalog(): Promise<void> {
    const result = ToolListResultSchema.parse(
      await this.invokeRpc('tools/list', {}),
    );
    const actual = sorted(result.tools.map((tool) => tool.name));
    const expected = sorted(EXPECTED_REMOTE_TOOL_NAMES);
    if (
      actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])
    ) {
      throw new AgentCoreMcpProtocolError(
        'Remote MCP tool catalog does not match the certified six-tool catalog.',
      );
    }
  }

  public async callRemoteTool(
    wireName: keyof typeof CLIENTOPS_TOOL_DEFINITIONS,
    input: unknown,
  ): Promise<unknown> {
    const definition = CLIENTOPS_TOOL_DEFINITIONS[wireName];
    const parsedInput = definition.inputSchema.parse(input);
    const result = ToolCallResultSchema.parse(
      await this.invokeRpc(
        'tools/call',
        { name: wireName, arguments: parsedInput },
        wireName,
      ),
    );

    if (result.isError) {
      throw new AgentCoreMcpProtocolError(
        'Remote MCP business tool returned a bounded error.',
      );
    }

    let candidate = result.structuredContent;
    if (candidate === undefined) {
      const text = result.content?.find(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )?.text;
      if (!text) {
        throw new AgentCoreMcpProtocolError(
          'Remote MCP tool response contained no structured content.',
        );
      }
      try {
        candidate = JSON.parse(text);
      } catch {
        throw new AgentCoreMcpProtocolError(
          'Remote MCP text fallback contained invalid JSON.',
        );
      }
    }

    return definition.outputSchema.parse(candidate);
  }

  public async createModelTools(): Promise<FunctionTool[]> {
    await this.assertCertifiedCatalog();

    return Object.values(TOOL_NAMES).map((wireName) => {
      const definition = CLIENTOPS_TOOL_DEFINITIONS[wireName];
      return new FunctionTool({
        name: normalizeToolName(wireName),
        description: definition.description,
        inputSchema: z.toJSONSchema(definition.inputSchema) as never,
        callback: async (input) =>
          this.callRemoteTool(wireName, input) as never,
      });
    });
  }
}

export class Phase521UnboundAgentCoreInvoker implements AgentCoreRuntimeInvoker {
  async invoke(): Promise<AgentCoreRuntimeInvocationResult> {
    throw new AgentCoreMcpProtocolError(
      'AgentCore data-plane binding is not configured in Phase 5.2.1.',
    );
  }
}
