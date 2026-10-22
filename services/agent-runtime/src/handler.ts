import { randomUUID } from 'node:crypto';
import type { ToolList } from '@strands-agents/sdk';
import { ClientOpsAgent, type AgentRunResult } from '@clientops/agent';
import { z } from 'zod';
import {
  AgentInvocationErrorCodeSchema,
  AgentInvocationFailureV1Schema,
  AgentInvocationRequestV1Schema,
  AgentInvocationResponseV1Schema,
  PHASE5_2_CERTIFICATION_MODEL_ID,
  type AgentInvocationResponseV1,
} from '@clientops/contracts';
import { AgentCoreMcpProtocolError } from './agentcore-mcp.js';
import type { AgentRuntimeServiceConfig } from './config.js';

export interface AgentRuntimeAgent {
  prepareClientBrief(input: {
    userMessage: string;
    accountHint?: string;
  }): Promise<AgentRunResult>;
  close(): Promise<void>;
}

export interface ProposalRegistrationRequest {
  organizationId: string;
  actorId: string;
  requestId: string;
  modelInput: unknown;
  evidenceResolver: NonNullable<AgentRunResult['evidenceResolver']>;
}

export interface ProposalRegistrationResult {
  proposalId: string;
  status: 'PENDING_APPROVAL';
  reviewUrl: string;
}

export interface ProposalRegistrar {
  register(
    request: ProposalRegistrationRequest,
  ): Promise<ProposalRegistrationResult>;
}

export interface AgentRuntimeLogger {
  error(
    event: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

export interface AgentRuntimeDependencies {
  loadTools(): Promise<ToolList>;
  createAgent(tools: ToolList): AgentRuntimeAgent;
  proposalRegistrar?: ProposalRegistrar;
  logger?: AgentRuntimeLogger;
}

export interface AgentRuntimeHttpResult {
  statusCode: number;
  body: AgentInvocationResponseV1;
}

const defaultLogger: AgentRuntimeLogger = {
  error(event, metadata) {
    console.error(event, metadata);
  },
};

type AgentInvocationErrorCode = z.infer<typeof AgentInvocationErrorCodeSchema>;

// Never log arbitrary Error.name: providers can set it to sensitive text.
function safeErrorType(error: unknown): 'Error' | 'UnknownError' {
  return error instanceof Error && error.name === 'Error'
    ? 'Error'
    : 'UnknownError';
}

function failure(
  code: AgentInvocationErrorCode,
  error: string,
  statusCode: number,
  requestId: string = randomUUID(),
): AgentRuntimeHttpResult {
  return {
    statusCode,
    body: AgentInvocationFailureV1Schema.parse({
      version: '1',
      requestId,
      success: false,
      code,
      error,
    }),
  };
}

function classifyAgentFailure(result: AgentRunResult): AgentRuntimeHttpResult {
  const requestId = randomUUID();
  const text = (result.error ?? '').toLowerCase();

  if (text.includes('mcp')) {
    return failure(
      'MCP_UNAVAILABLE',
      'ClientOps MCP service is temporarily unavailable.',
      503,
      requestId,
    );
  }
  if (text.includes('auth') || text.includes('credential')) {
    return failure(
      'AWS_BEDROCK_AUTH_ERROR',
      'Amazon Bedrock credentials are unavailable or unauthorized.',
      503,
      requestId,
    );
  }
  if (text.includes('throttl') || text.includes('rate')) {
    return failure(
      'AWS_BEDROCK_THROTTLED',
      'Amazon Bedrock temporarily rate-limited the request.',
      429,
      requestId,
    );
  }
  if (text.includes('timeout') || text.includes('cancel')) {
    return failure(
      'AGENT_TIMEOUT',
      'Agent invocation exceeded its configured execution limit.',
      504,
      requestId,
    );
  }
  if (text.includes('model')) {
    return failure(
      'AWS_BEDROCK_MODEL_ERROR',
      'Configured Amazon Bedrock model is unavailable.',
      502,
      requestId,
    );
  }
  if (!result.grounding.valid) {
    return failure(
      'GROUNDING_VALIDATION_FAILED',
      'Agent response failed authoritative grounding validation.',
      422,
      requestId,
    );
  }
  return failure(
    'AGENT_EXECUTION_FAILED',
    'Agentic briefing preparation failed.',
    400,
    requestId,
  );
}

function sanitizePublicTrace(result: AgentRunResult) {
  return result.toolTrace.map((step) => ({
    toolName: step.toolName,
    status: step.status,
    durationMs: Math.max(0, Math.trunc(step.durationMs)),
    evidenceCount: step.evidenceReferences.length,
  }));
}

export function createDefaultAgentFactory(
  config: AgentRuntimeServiceConfig,
): (tools: ToolList) => AgentRuntimeAgent {
  return (tools) =>
    new ClientOpsAgent({
      config: {
        awsRegion: config.awsRegion,
        bedrockModelId: config.modelId,
        maxTurns: config.maxTurns,
        maxOutputTokens: config.maxOutputTokens,
        maxTotalTokens: config.maxTotalTokens,
        timeoutMs: config.timeoutMs,
        temperature: config.temperature,
      },
      tools,
    });
}

export function createAgentRuntimeHandler(
  config: AgentRuntimeServiceConfig,
  dependencies: AgentRuntimeDependencies,
) {
  const logger = dependencies.logger ?? defaultLogger;

  return async function handleAgentRuntimeInvocation(
    rawInput: unknown,
  ): Promise<AgentRuntimeHttpResult> {
    const parsedRequest = AgentInvocationRequestV1Schema.safeParse(rawInput);
    if (!parsedRequest.success) {
      return failure(
        'INVALID_INVOCATION',
        'Invocation body does not match the Agent Runtime V1 contract.',
        400,
      );
    }

    const request = parsedRequest.data;
    if (
      request.organizationId !== config.certificationOrganizationId ||
      request.actorId !== config.certificationActorId
    ) {
      return failure(
        'CERTIFICATION_IDENTITY_MISMATCH',
        'Invocation identity is not authorized for this non-production runtime.',
        403,
        request.requestId,
      );
    }

    let agent: AgentRuntimeAgent | undefined;
    try {
      const tools = await dependencies.loadTools();
      agent = dependencies.createAgent(tools);
      const result = await agent.prepareClientBrief({
        userMessage: request.userMessage,
        ...(request.accountHint ? { accountHint: request.accountHint } : {}),
      });

      if (!result.success || !result.brief) {
        const classified = classifyAgentFailure(result);
        return {
          ...classified,
          body: {
            ...classified.body,
            requestId: request.requestId,
          },
        };
      }

      if (
        result.modelId !== PHASE5_2_CERTIFICATION_MODEL_ID ||
        !result.grounding.valid ||
        result.grounding.unsupportedEvidenceCount !== 0
      ) {
        return failure(
          'GROUNDING_VALIDATION_FAILED',
          'Agent response did not satisfy the frozen certification grounding/model contract.',
          422,
          request.requestId,
        );
      }

      let actionProposal:
        | {
            proposalId: string;
            status: 'PENDING_APPROVAL';
            reviewUrl: string;
          }
        | undefined;

      if (result.brief.mode === 'action_proposal') {
        if (!result.brief.proposedAction || !result.evidenceResolver) {
          return failure(
            'ACTION_PROPOSAL_REGISTRATION_FAILED',
            'Grounded proposal registration prerequisites are unavailable.',
            422,
            request.requestId,
          );
        }
        if (!dependencies.proposalRegistrar) {
          return failure(
            'ACTION_STORE_UNAVAILABLE',
            'Proposal persistence is not configured for this runtime.',
            503,
            request.requestId,
          );
        }

        try {
          actionProposal = await dependencies.proposalRegistrar.register({
            organizationId: request.organizationId,
            actorId: request.actorId,
            requestId: request.requestId,
            modelInput: result.brief.proposedAction,
            evidenceResolver: result.evidenceResolver,
          });
        } catch (error: unknown) {
          logger.error('agent_runtime_proposal_registration_failed', {
            code: 'ACTION_PROPOSAL_REGISTRATION_FAILED',
            errorType: safeErrorType(error),
          });
          return failure(
            'ACTION_PROPOSAL_REGISTRATION_FAILED',
            'Action proposal registration failed. No action was approved or executed.',
            422,
            request.requestId,
          );
        }
      }

      const body = AgentInvocationResponseV1Schema.parse({
        version: '1',
        requestId: request.requestId,
        success: true,
        data: {
          brief: result.brief,
          toolTrace: sanitizePublicTrace(result),
          modelId: result.modelId,
          stopReason: result.stopReason,
          latencyMs: Math.max(0, Math.trunc(result.latencyMs)),
          ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
          grounding: {
            valid: true,
            unsupportedEvidenceCount: 0,
          },
          ...(actionProposal ? { actionProposal } : {}),
        },
      });

      return { statusCode: 200, body };
    } catch (error: unknown) {
      logger.error('agent_runtime_invocation_failed', {
        code: 'SERVER_ERROR',
        errorType: safeErrorType(error),
      });

      const isMcpFailure = error instanceof AgentCoreMcpProtocolError;

      return failure(
        isMcpFailure ? 'MCP_UNAVAILABLE' : 'SERVER_ERROR',
        isMcpFailure
          ? 'ClientOps MCP service is temporarily unavailable.'
          : 'An unexpected server error occurred during agent invocation.',
        isMcpFailure ? 503 : 500,
        request.requestId,
      );
    } finally {
      if (agent) {
        try {
          await agent.close();
        } catch {
          logger.error('agent_runtime_agent_cleanup_failed', {
            code: 'AGENT_CLEANUP_FAILED',
          });
        }
      }
    }
  };
}
