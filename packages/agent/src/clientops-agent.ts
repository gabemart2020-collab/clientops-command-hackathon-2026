import {
  Agent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  McpClient,
  type Model,
  type ToolList,
} from '@strands-agents/sdk';
import {
  AgentBriefSchema,
  AgentModelOutputSchema,
  type AgentBrief,
  type AgentBriefFinding,
  type AgentModelOutput,
} from '@clientops/contracts';
import { loadAgentConfig, type AgentRuntimeConfig } from './config.js';
import { createClientOpsModel } from './model.js';
import {
  createClientOpsMcpClient,
  loadAuthorizedMcpTools,
  isToolAuthorized,
} from './mcp.js';
import { CLIENTOPS_SYSTEM_PROMPT } from './prompt.js';
import { GroundingValidator } from './grounding.js';
import { RequestExecutionTracker } from './trace.js';
import { destroyModelResources } from './lifecycle.js';
import type {
  AgentBriefRequest,
  AgentRunResult,
  GroundingValidationResult,
  TokenUsage,
} from './schemas.js';

export interface ClientOpsAgentOptions {
  config?: Partial<AgentRuntimeConfig>;
  model?: Model;
  tools?: ToolList;
  mcpClient?: McpClient;
}

export class ClientOpsAgent {
  private readonly config: AgentRuntimeConfig;
  private readonly model: Model;
  private readonly customTools: ToolList | undefined;
  private readonly injectedMcpClient: McpClient | undefined;

  constructor(options: ClientOpsAgentOptions = {}) {
    this.config = loadAgentConfig(options.config);
    this.model = options.model ?? createClientOpsModel(this.config);
    this.customTools = options.tools;
    this.injectedMcpClient = options.mcpClient;
  }

  public getConfig(): AgentRuntimeConfig {
    return { ...this.config };
  }

  public getModel(): Model {
    return this.model;
  }

  /**
   * Deterministically cleans up any underlying persistent resources or client connection pools.
   */
  public async close(): Promise<void> {
    destroyModelResources(this.model);
  }

  /**
   * Prepares a grounded, evidence-backed client briefing or answers an operational query.
   */
  public async prepareClientBrief(
    request: AgentBriefRequest,
  ): Promise<AgentRunResult> {
    const startTime = Date.now();
    const tracker = new RequestExecutionTracker();
    const groundingValidator = new GroundingValidator();
    let mcpClient: McpClient | undefined;

    try {
      // Resolve tools: use custom tools if injected (e.g. for offline testing),
      // otherwise discover and normalize authorized tools from the MCP server.
      let agentTools: ToolList;
      if (this.customTools) {
        agentTools = this.customTools;
        if (this.injectedMcpClient) {
          mcpClient = this.injectedMcpClient;
        }
      } else if (this.injectedMcpClient) {
        mcpClient = this.injectedMcpClient;
        agentTools = await loadAuthorizedMcpTools(mcpClient);
      } else {
        mcpClient = createClientOpsMcpClient(this.config.mcpUrl);
        agentTools = await loadAuthorizedMcpTools(mcpClient);
      }

      // Construct Strands agent instance for this request with structured output schema
      const agent = new Agent({
        model: this.model,
        tools: agentTools,
        systemPrompt: CLIENTOPS_SYSTEM_PROMPT,
        printer: false,
        structuredOutputSchema: AgentModelOutputSchema,
      });

      // Hook: BeforeToolCallEvent (Tool allowlist enforcement & trace capture)
      agent.addHook(BeforeToolCallEvent, (event) => {
        const toolName = event.toolUse.name;
        // Strands internal structured output tool must not be intercepted or canceled
        if (toolName === 'strands_structured_output') {
          return;
        }

        tracker.onBeforeCall(
          event.toolUse.toolUseId,
          toolName,
          event.toolUse.input,
        );

        // Defense-in-depth: fail-closed if any unexpected or unauthorized tool is called
        if (!isToolAuthorized(toolName)) {
          event.cancel = `UNAUTHORIZED_TOOL: The tool "${toolName}" is not authorized for the ClientOps operations agent.`;
        }
      });

      // Hook: AfterToolCallEvent (Evidence capture and trace recording)
      agent.addHook(AfterToolCallEvent, (event) => {
        const toolName = event.toolUse.name;
        // Strands internal structured output tool is not an MCP domain tool
        if (toolName === 'strands_structured_output') {
          return;
        }

        const isError = Boolean(event.error) || event.result.status === 'error';
        const errorMessage =
          event.error?.message ??
          (isError &&
          event.result.content?.[0] &&
          'text' in event.result.content[0]
            ? event.result.content[0].text
            : undefined);

        // Extract evidence from tool output blocks
        const collectedEvidence = [];
        if (!isError && event.result.content) {
          for (const block of event.result.content) {
            if ('json' in block && block.json) {
              const extracted =
                groundingValidator.extractAndRegisterFromToolOutput(
                  toolName,
                  block.json,
                );
              collectedEvidence.push(...extracted);
            } else if ('text' in block && typeof block.text === 'string') {
              try {
                const parsed = JSON.parse(block.text);
                const extracted =
                  groundingValidator.extractAndRegisterFromToolOutput(
                    toolName,
                    parsed,
                  );
                collectedEvidence.push(...extracted);
              } catch {
                // Unstructured text block; non-JSON
              }
            }
          }
        }

        tracker.onAfterCall(
          event.toolUse.toolUseId,
          toolName,
          collectedEvidence,
          isError,
          errorMessage,
        );
      });

      // Compose user prompt incorporating optional account context hint
      let promptText = request.userMessage.trim();
      if (request.accountHint && request.accountHint.trim()) {
        promptText = `Target Account Hint: "${request.accountHint.trim()}".\n\nUser Request: ${promptText}`;
      }

      const invokeOptions = {
        cancelSignal: AbortSignal.timeout(this.config.timeoutMs),
        limits: {
          turns: this.config.maxTurns,
          outputTokens: this.config.maxOutputTokens,
          totalTokens: this.config.maxTotalTokens,
        },
      };

      const result = await agent.invoke(promptText, invokeOptions);
      const latencyMs = Date.now() - startTime;

      // Extract token usage where available
      let tokenUsage: TokenUsage | undefined;
      if (result.metrics?.accumulatedUsage) {
        tokenUsage = {
          inputTokens: result.metrics.accumulatedUsage.inputTokens,
          outputTokens: result.metrics.accumulatedUsage.outputTokens,
          totalTokens: result.metrics.accumulatedUsage.totalTokens,
        };
      }

      // Consume validated structured output
      let brief: AgentBrief | undefined;
      const rawText = result.toString();

      if (result.structuredOutput) {
        const parsedModel = AgentModelOutputSchema.safeParse(
          result.structuredOutput,
        );
        if (parsedModel.success) {
          brief = normalizeModelOutputToBrief(parsedModel.data);
        } else {
          const parsedBrief = AgentBriefSchema.safeParse(
            result.structuredOutput,
          );
          if (parsedBrief.success) {
            brief = parsedBrief.data;
          }
        }
      }

      // Narrowly scoped fallback for text responses if structuredOutput was not set
      if (!brief && rawText) {
        brief = tryExtractBriefFromText(rawText);
      }

      const stopReason = result.stopReason || 'end_turn';
      let error: string | undefined;
      let success = true;

      // Resolve citations into canonical authoritative EvidenceRefs and validate grounding
      let grounding: GroundingValidationResult;
      if (brief) {
        const resolution = groundingValidator.resolveAndHydrateBrief(brief);
        brief = resolution.brief;
        grounding = resolution.grounding;
        if (!grounding.valid) {
          success = false;
          error =
            grounding.message ??
            `Grounding validation failed: ${grounding.unsupportedEvidenceCount} unsupported evidence reference(s).`;
        }
      } else {
        success = false;
        error = 'Agent failed to produce a valid structured brief.';
        grounding = {
          valid: false,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount:
            groundingValidator.getAuthoritativeCount(),
          unsupportedReferences: [],
          message:
            'Grounding validation was skipped: No valid structured brief was produced.',
        };
      }

      if (stopReason === 'limitTurns') {
        success = false;
        error = `Agent exceeded maximum turn limit (${this.config.maxTurns}). Agent failed to produce a valid structured brief.`;
      } else if (stopReason === 'limitOutputTokens') {
        success = false;
        error = `Agent exceeded maximum output token limit (${this.config.maxOutputTokens}).`;
      } else if (stopReason === 'limitTotalTokens') {
        success = false;
        error = `Agent exceeded maximum total token limit (${this.config.maxTotalTokens}).`;
      } else if (stopReason === 'cancelled') {
        success = false;
        error = `Agent invocation cancelled or timed out (${this.config.timeoutMs}ms).`;
      }

      return {
        success,
        brief,
        rawText,
        toolTrace: tracker.getTraces(),
        modelId: this.config.bedrockModelId,
        stopReason,
        latencyMs,
        ...(tokenUsage ? { tokenUsage } : {}),
        grounding,
        evidenceResolver: groundingValidator,
        ...(error ? { error } : {}),
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const errorMsg = (err as Error).message || String(err);

      let safeError = errorMsg;
      if (
        errorMsg.includes('UnrecognizedClientException') ||
        errorMsg.includes('AccessDeniedException') ||
        errorMsg.includes('Credentials') ||
        errorMsg.includes('Could not load credentials')
      ) {
        safeError =
          'AWS_BEDROCK_AUTH_ERROR: Bedrock credentials unavailable or unauthorized. Verify AWS environment and IAM permissions.';
      } else if (
        errorMsg.includes('ResourceNotFoundException') ||
        errorMsg.includes('ValidationException')
      ) {
        safeError = `AWS_BEDROCK_MODEL_ERROR: Configured Bedrock model "${this.config.bedrockModelId}" is unavailable in region "${this.config.awsRegion}".`;
      } else if (
        errorMsg.includes('ThrottlingException') ||
        errorMsg.includes('TooManyRequestsException')
      ) {
        safeError =
          'AWS_BEDROCK_THROTTLED: Request to Amazon Bedrock was rate-limited. Retry after backoff.';
      } else if (
        errorMsg.includes('Timeout') ||
        errorMsg.includes('AbortError')
      ) {
        safeError = `AGENT_TIMEOUT: Invocation exceeded wall-clock timeout (${this.config.timeoutMs}ms).`;
      }

      const emptyGrounding: GroundingValidationResult = {
        valid: false,
        groundedEvidenceCount: 0,
        unsupportedEvidenceCount: 0,
        authoritativeEvidenceCount: groundingValidator.getAuthoritativeCount(),
        unsupportedReferences: [],
        message:
          'Grounding validation was skipped due to agent execution error.',
      };

      return {
        success: false,
        toolTrace: tracker.getTraces(),
        modelId: this.config.bedrockModelId,
        stopReason: 'error',
        latencyMs,
        grounding: emptyGrounding,
        error: safeError,
      };
    } finally {
      if (mcpClient) {
        try {
          await mcpClient.disconnect();
        } catch {
          // Ignore disconnect error during cleanup
        }
      }
    }
  }
}

function normalizeModelOutputToBrief(m: AgentModelOutput): AgentBrief {
  return {
    mode: m.mode,
    ...(m.refusalReason ? { refusalReason: m.refusalReason } : {}),
    answer: m.answer,
    ...(m.account ? { account: m.account } : {}),
    ...(m.meeting ? { meeting: m.meeting } : {}),
    ...(m.health ? { health: m.health } : {}),
    findings: m.findings as unknown as AgentBriefFinding[],
    suggestedNextSteps: m.suggestedNextSteps,
    ...(m.proposedAction ? { proposedAction: m.proposedAction } : {}),
  };
}

function tryExtractBriefFromText(text: string): AgentBrief | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }

  // Look for ```json ... ``` blocks
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = jsonBlockRegex.exec(text);
  const candidate = match ? match[1] : text.trim();

  try {
    const parsed = JSON.parse(candidate ?? text);
    const validatedModel = AgentModelOutputSchema.safeParse(parsed);
    if (validatedModel.success) {
      return normalizeModelOutputToBrief(validatedModel.data);
    }
    const validated = AgentBriefSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}
