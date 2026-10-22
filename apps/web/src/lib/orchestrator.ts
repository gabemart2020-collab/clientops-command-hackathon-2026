import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  GetAccountContextOutputSchema,
  PrepareBriefOutputSchema,
  TOOL_NAMES,
  type GetAccountContextOutput,
  type PrepareBriefOutput,
} from '@clientops/contracts';

const MCP_BASELINE = '2025-11-25';

export interface WorkflowTraceStep {
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  status: 'ok' | 'error';
}

export interface OrchestrationResult {
  clientContext: GetAccountContextOutput;
  brief: PrepareBriefOutput;
  trace: WorkflowTraceStep[];
}

/**
 * Deterministic Demo Orchestrator for Phase 2.
 *
 * NOTE: This is NOT an AI agent and DOES NOT perform LLM planning or model reasoning.
 * Its purpose is to demonstrate that deterministic business data flows end-to-end
 * through the official MCP client over Streamable HTTP, calling ClientOps domain tools,
 * and returning structured evidence-backed results for presentation.
 */
export class DeterministicDemoOrchestrator {
  constructor(
    private readonly mcpUrl: string = process.env.CLIENTOPS_MCP_URL ||
      'http://127.0.0.1:3001/mcp',
  ) {}

  async runHeroWorkflow(
    accountRef = 'Acme Labs',
  ): Promise<OrchestrationResult> {
    const trace: WorkflowTraceStep[] = [];
    const client = new Client(
      { name: 'clientops-web-orchestrator', version: '0.2.0' },
      {
        supportedProtocolVersions: [MCP_BASELINE],
        versionNegotiation: { mode: 'legacy' },
      },
    );

    let transport: StreamableHTTPClientTransport;
    try {
      transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
      await client.connect(transport);
    } catch (error) {
      throw new Error(
        `MCP_UNAVAILABLE: Could not connect to ClientOps MCP service at ${this.mcpUrl}. Ensure the MCP service is running (pnpm dev:mcp). Cause: ${(error as Error).message}`,
        { cause: error },
      );
    }

    try {
      // Step 1: Resolve Account Context via official MCP client
      const step1Start = Date.now();
      const accountArgs = { account_ref: accountRef };
      const accountCallResult = await client.callTool({
        name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        arguments: accountArgs,
      });

      trace.push({
        tool: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        arguments: accountArgs,
        durationMs: Date.now() - step1Start,
        status: accountCallResult.isError ? 'error' : 'ok',
      });

      if (accountCallResult.isError) {
        const errorMsg =
          (accountCallResult.content?.[0] as { text?: string })?.text ??
          'Unknown MCP error during account resolution';
        throw new Error(`ACCOUNT_RESOLUTION_FAILED: ${errorMsg}`);
      }

      const clientContext = GetAccountContextOutputSchema.parse(
        accountCallResult.structuredContent,
      );

      // Step 2: Locate upcoming review meeting
      const targetMeeting =
        clientContext.upcomingMeetings.find((m) =>
          m.title.toLowerCase().includes('review'),
        ) ?? clientContext.upcomingMeetings[0];

      if (!targetMeeting) {
        throw new Error(
          `MEETING_NOT_FOUND: No upcoming review meeting found for client "${clientContext.client.name}".`,
        );
      }

      // Step 3: Prepare Brief via official MCP client
      const step2Start = Date.now();
      const briefArgs = { meeting_id: targetMeeting.id };
      const briefCallResult = await client.callTool({
        name: TOOL_NAMES.MEETING_PREPARE_BRIEF,
        arguments: briefArgs,
      });

      trace.push({
        tool: TOOL_NAMES.MEETING_PREPARE_BRIEF,
        arguments: briefArgs,
        durationMs: Date.now() - step2Start,
        status: briefCallResult.isError ? 'error' : 'ok',
      });

      if (briefCallResult.isError) {
        const errorMsg =
          (briefCallResult.content?.[0] as { text?: string })?.text ??
          'Unknown MCP error during brief preparation';
        throw new Error(`BRIEF_PREPARATION_FAILED: ${errorMsg}`);
      }

      const brief = PrepareBriefOutputSchema.parse(
        briefCallResult.structuredContent,
      );

      return {
        clientContext,
        brief,
        trace,
      };
    } finally {
      await client.close();
    }
  }
}
