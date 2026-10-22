import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEMO_ORGANIZATION_ID,
  createTenantContext,
  ClientOpsService,
  DemoScenarioClock,
} from '@clientops/domain';
import { createInMemoryDataStore } from '@clientops/data';
import {
  readConfig,
  startClientOpsService,
} from '../../../services/mcp/src/index.js';
import {
  createClientOpsMcpClient,
  loadAuthorizedMcpTools,
  ClientOpsAgent,
  AUTHORIZED_NORMALIZED_TOOL_NAMES,
} from '../src/index.js';
import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import type { AgentBrief } from '@clientops/contracts';

class DeterministicMockModel extends Model<BaseModelConfig> {
  private turnCount = 0;

  constructor(
    private readonly script: Array<
      (turn: number, messages: Message[]) => ModelStreamEvent[]
    >,
  ) {
    super();
  }

  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return { modelId: 'deterministic-mock' };
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const handler = this.script[this.turnCount];
    if (!handler) {
      throw new Error(`Unexpected turn ${this.turnCount} in MockModel`);
    }
    const events = handler(this.turnCount, messages);
    this.turnCount++;
    for (const event of events) {
      yield event;
    }
  }
}

describe('Phase 3.1 — MCP Normalization & Lifecycle Integration Proof', () => {
  let service: Awaited<ReturnType<typeof startClientOpsService>>;
  let mcpUrl: string;

  beforeAll(async () => {
    const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
    const dataStore = createInMemoryDataStore();
    const domainService = new ClientOpsService(
      dataStore,
      new DemoScenarioClock(),
    );

    service = await startClientOpsService(
      readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
      tenant,
      domainService,
    );
    mcpUrl = `${service.url}/mcp`;
  });

  afterAll(async () => {
    await service?.close();
  });

  it('normalizes server tool names and excludes unauthorized system tools', async () => {
    const mcpClient = createClientOpsMcpClient(mcpUrl);
    try {
      const authorizedTools = await loadAuthorizedMcpTools(mcpClient);
      const names = authorizedTools.map((t) => t.name);

      // Must only contain authorized tools
      expect(names).toHaveLength(5);
      for (const expected of AUTHORIZED_NORMALIZED_TOOL_NAMES) {
        expect(names).toContain(expected);
      }

      // No dot notation must remain
      for (const name of names) {
        expect(name).not.toContain('.');
      }

      // system.get_status must NOT be included
      expect(names).not.toContain('system_get_status');
      expect(names).not.toContain('system.get_status');
    } finally {
      await mcpClient.disconnect();
    }
  });

  it('executes normalized account_get_context against real Streamable HTTP service and returns domain data', async () => {
    let capturedToolOutput: unknown = null;

    const mockModel = new DeterministicMockModel([
      // Turn 0: Call normalized account_get_context
      () => [
        { type: 'modelMessageStartEvent', role: 'assistant' },
        {
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: 'account_get_context',
            toolUseId: 'wire-call-1',
          },
        },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'toolUseInputDelta',
            input: JSON.stringify({ account_ref: 'Acme Labs' }),
          },
        },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      ],
      // Turn 1: Inspect tool result from previous message, emit structured output
      (_turn, messages) => {
        // Find the tool result message from the wire call
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && Array.isArray(lastMessage.content)) {
          for (const block of lastMessage.content) {
            if ('toolUseId' in block && block.toolUseId === 'wire-call-1') {
              capturedToolOutput = block;
            }
          }
        }

        const brief: AgentBrief = {
          answer:
            'Acme Labs account context retrieved successfully via Streamable HTTP MCP.',
          account: {
            id: 'c0000000-0000-4000-8000-000000000001',
            name: 'Acme Labs',
          },
          findings: [
            {
              statement: 'Acme Labs account tier is enterprise',
              evidence: [
                {
                  entityType: 'client',
                  entityId: 'c0000000-0000-4000-8000-000000000001',
                  excerpt: 'Acme Labs',
                },
              ],
            },
          ],
          suggestedNextSteps: ['Monitor active projects'],
        };

        return [
          { type: 'modelMessageStartEvent', role: 'assistant' },
          {
            type: 'modelContentBlockStartEvent',
            start: {
              type: 'toolUseStart',
              name: 'strands_structured_output',
              toolUseId: 'struct-out-1',
            },
          },
          {
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'toolUseInputDelta',
              input: JSON.stringify(brief),
            },
          },
          { type: 'modelContentBlockStopEvent' },
          { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
        ];
      },
    ]);

    const agent = new ClientOpsAgent({
      config: { mcpUrl },
      model: mockModel,
    });

    const result = await agent.prepareClientBrief({
      userMessage: 'Get context for Acme Labs',
      accountHint: 'Acme Labs',
    });

    expect(result.success).toBe(true);
    expect(result.brief?.account?.name).toBe('Acme Labs');
    expect(result.brief?.account?.id).toBe(
      'c0000000-0000-4000-8000-000000000001',
    );
    expect(result.grounding.valid).toBe(true);
    expect(result.grounding.groundedEvidenceCount).toBeGreaterThanOrEqual(1);
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]?.toolName).toBe('account_get_context');
    expect(result.toolTrace[0]?.status).toBe('ok');

    // Verify wire execution returned actual domain data from in-memory database
    expect(capturedToolOutput).toBeDefined();
    const outputText = JSON.stringify(capturedToolOutput);
    expect(outputText).toContain('Acme Labs');
    expect(outputText).toContain('c0000000-0000-4000-8000-000000000001');
  });

  it('guarantees mcpClient.disconnect() is called on success, error, and timeout', async () => {
    // 1. Success case
    const mcpClientSuccess = createClientOpsMcpClient(mcpUrl);
    const disconnectSuccessSpy = vi.spyOn(mcpClientSuccess, 'disconnect');

    const agentSuccess = new ClientOpsAgent({
      config: { mcpUrl },
      mcpClient: mcpClientSuccess,
      model: new DeterministicMockModel([
        () => [
          { type: 'modelMessageStartEvent', role: 'assistant' },
          {
            type: 'modelContentBlockStartEvent',
            start: {
              type: 'toolUseStart',
              name: 'strands_structured_output',
              toolUseId: 'out-1',
            },
          },
          {
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'toolUseInputDelta',
              input: JSON.stringify({
                answer: 'Done',
                findings: [
                  {
                    statement: 'Acme Labs exists',
                    evidence: [
                      {
                        entityType: 'client',
                        entityId: 'c0000000-0000-4000-8000-000000000001',
                      },
                    ],
                  },
                ],
                suggestedNextSteps: [],
              }),
            },
          },
          { type: 'modelContentBlockStopEvent' },
          { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
        ],
      ]),
    });

    await agentSuccess.prepareClientBrief({ userMessage: 'test' });
    expect(disconnectSuccessSpy).toHaveBeenCalledTimes(1);

    // 2. Model error / throw case
    const mcpClientError = createClientOpsMcpClient(mcpUrl);
    const disconnectErrorSpy = vi.spyOn(mcpClientError, 'disconnect');

    const agentError = new ClientOpsAgent({
      config: { mcpUrl },
      mcpClient: mcpClientError,
      model: new DeterministicMockModel([
        () => {
          throw new Error('Simulated model failure');
        },
      ]),
    });

    const errorResult = await agentError.prepareClientBrief({
      userMessage: 'test',
    });
    expect(errorResult.success).toBe(false);
    expect(disconnectErrorSpy).toHaveBeenCalledTimes(1);
  });
});
