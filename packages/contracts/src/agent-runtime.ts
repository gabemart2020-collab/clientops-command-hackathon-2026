import { z } from 'zod';
import { AgentBriefSchema } from './brief.js';

export const PHASE5_2_CERTIFICATION_MODEL_ID =
  'us.anthropic.claude-sonnet-4-6' as const;

export const AGENT_RUNTIME_HTTP_CONTRACT = {
  protocol: 'HTTP',
  host: '0.0.0.0',
  port: 8080,
  invocationPath: '/invocations',
  pingPath: '/ping',
  architecture: 'linux/arm64',
  nodeMajor: 24,
  mcpProtocolVersion: '2025-11-25',
} as const;

export const AGENT_RUNTIME_MODEL_TOOL_NAMES = [
  'account_get_context',
  'activity_get_recent',
  'commitment_list_open',
  'project_assess_delivery_health',
  'meeting_prepare_brief',
] as const;

export const AgentRuntimeModelToolNameSchema = z.enum(
  AGENT_RUNTIME_MODEL_TOOL_NAMES,
);

export const AgentInvocationRequestV1Schema = z
  .object({
    version: z.literal('1'),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    organizationId: z.string().uuid(),
    actorId: z.string().uuid(),
    userMessage: z.string().trim().min(1).max(8000),
    accountHint: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type AgentInvocationRequestV1 = z.infer<
  typeof AgentInvocationRequestV1Schema
>;

/** B1 offline JWS claims. The embedded request is the complete signed V1 payload. */
export const SignedInvocationEnvelopeV1Schema = z
  .object({
    envelopeVersion: z.literal('1'),
    callerId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    audience: z.string().min(1).max(256),
    intent: z.enum(['NEW', 'RETRY']),
    organizationId: z.string().uuid(),
    actorId: z.string().uuid(),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    replayId: z.string().uuid(),
    request: AgentInvocationRequestV1Schema,
  })
  .strict();

export type SignedInvocationEnvelopeV1 = z.infer<
  typeof SignedInvocationEnvelopeV1Schema
>;

export const AgentRuntimeCertificationIdentitySchema = z
  .object({
    organizationId: z.string().uuid(),
    actorId: z.string().uuid(),
  })
  .strict();

export type AgentRuntimeCertificationIdentity = z.infer<
  typeof AgentRuntimeCertificationIdentitySchema
>;

export const AgentRuntimePublicToolTraceSchema = z
  .object({
    toolName: AgentRuntimeModelToolNameSchema,
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative().max(300_000),
    evidenceCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export type AgentRuntimePublicToolTrace = z.infer<
  typeof AgentRuntimePublicToolTraceSchema
>;

export const AgentRuntimeTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export const AgentRuntimeGroundingSummarySchema = z
  .object({
    valid: z.literal(true),
    unsupportedEvidenceCount: z.literal(0),
  })
  .strict();

export const AgentRuntimeProposalMetadataSchema = z
  .object({
    proposalId: z.string().uuid(),
    status: z.literal('PENDING_APPROVAL'),
    reviewUrl: z
      .string()
      .max(128)
      .regex(
        /^\/actions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
  })
  .strict();

export const AgentInvocationSuccessDataV1Schema = z
  .object({
    brief: AgentBriefSchema,
    toolTrace: z.array(AgentRuntimePublicToolTraceSchema).max(32),
    modelId: z.literal(PHASE5_2_CERTIFICATION_MODEL_ID),
    stopReason: z.string().trim().min(1).max(64),
    latencyMs: z.number().int().nonnegative().max(600_000),
    tokenUsage: AgentRuntimeTokenUsageSchema.optional(),
    grounding: AgentRuntimeGroundingSummarySchema,
    actionProposal: AgentRuntimeProposalMetadataSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const proposalMode = data.brief.mode === 'action_proposal';
    if (proposalMode && !data.actionProposal) {
      ctx.addIssue({
        code: 'custom',
        path: ['actionProposal'],
        message:
          'actionProposal is required when brief.mode is action_proposal',
      });
    }
    if (!proposalMode && data.actionProposal) {
      ctx.addIssue({
        code: 'custom',
        path: ['actionProposal'],
        message:
          'actionProposal must be absent unless brief.mode is action_proposal',
      });
    }
  });

export const AgentInvocationSuccessV1Schema = z
  .object({
    version: z.literal('1'),
    requestId: z.string().uuid(),
    success: z.literal(true),
    data: AgentInvocationSuccessDataV1Schema,
  })
  .strict();

export const AgentInvocationErrorCodeSchema = z.enum([
  'INVALID_INVOCATION',
  'CERTIFICATION_IDENTITY_MISMATCH',
  'AGENT_EXECUTION_FAILED',
  'MCP_UNAVAILABLE',
  'AWS_BEDROCK_AUTH_ERROR',
  'AWS_BEDROCK_MODEL_ERROR',
  'AWS_BEDROCK_THROTTLED',
  'AGENT_TIMEOUT',
  'GROUNDING_VALIDATION_FAILED',
  'INVALID_PROPOSAL_MODE',
  'ACTION_PROPOSAL_REGISTRATION_FAILED',
  'ACTION_STORE_UNAVAILABLE',
  'SERVER_ERROR',
]);

export const AgentInvocationFailureV1Schema = z
  .object({
    version: z.literal('1'),
    requestId: z.string().uuid(),
    success: z.literal(false),
    code: AgentInvocationErrorCodeSchema,
    error: z.string().trim().min(1).max(500),
  })
  .strict();

export const AgentInvocationResponseV1Schema = z.discriminatedUnion('success', [
  AgentInvocationSuccessV1Schema,
  AgentInvocationFailureV1Schema,
]);

export type AgentInvocationResponseV1 = z.infer<
  typeof AgentInvocationResponseV1Schema
>;
