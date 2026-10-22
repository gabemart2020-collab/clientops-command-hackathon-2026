import { z } from 'zod';
import {
  AGENT_RUNTIME_HTTP_CONTRACT,
  PHASE5_2_CERTIFICATION_MODEL_ID,
} from '@clientops/contracts';

const AgentRuntimeServiceConfigSchema = z
  .object({
    host: z.literal(AGENT_RUNTIME_HTTP_CONTRACT.host),
    port: z.literal(AGENT_RUNTIME_HTTP_CONTRACT.port),
    awsRegion: z.string().min(1),
    modelId: z.literal(PHASE5_2_CERTIFICATION_MODEL_ID),
    mcpRuntimeArn: z
      .string()
      .regex(
        /^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/,
      ),
    mcpQualifier: z.string().min(1).max(64),
    certificationOrganizationId: z.string().uuid(),
    certificationActorId: z.string().uuid(),
    maxBodyBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    maxTurns: z.number().int().positive().max(20),
    maxOutputTokens: z.number().int().positive().max(16_000),
    maxTotalTokens: z.number().int().positive().max(64_000),
    timeoutMs: z.number().int().positive().max(120_000),
    temperature: z.number().min(0).max(1),
  })
  .strict();

export type AgentRuntimeServiceConfig = z.infer<
  typeof AgentRuntimeServiceConfigSchema
>;

export function parseAgentRuntimeServiceConfig(
  input: AgentRuntimeServiceConfig,
): AgentRuntimeServiceConfig {
  return AgentRuntimeServiceConfigSchema.parse(input);
}

export function loadAgentRuntimeServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeServiceConfig {
  return AgentRuntimeServiceConfigSchema.parse({
    host: AGENT_RUNTIME_HTTP_CONTRACT.host,
    port: AGENT_RUNTIME_HTTP_CONTRACT.port,
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    modelId: env.BEDROCK_MODEL_ID ?? PHASE5_2_CERTIFICATION_MODEL_ID,
    mcpRuntimeArn: env.CLIENTOPS_AGENT_MCP_RUNTIME_ARN,
    mcpQualifier: env.CLIENTOPS_AGENT_MCP_QUALIFIER ?? 'DEFAULT',
    certificationOrganizationId: env.CLIENTOPS_CERTIFICATION_ORGANIZATION_ID,
    certificationActorId: env.CLIENTOPS_CERTIFICATION_ACTOR_ID,
    maxBodyBytes: env.CLIENTOPS_AGENT_MAX_BODY_BYTES
      ? Number(env.CLIENTOPS_AGENT_MAX_BODY_BYTES)
      : 65_536,
    maxTurns: env.AGENT_MAX_TURNS ? Number(env.AGENT_MAX_TURNS) : 6,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS
      ? Number(env.AGENT_MAX_OUTPUT_TOKENS)
      : 2000,
    maxTotalTokens: env.AGENT_MAX_TOTAL_TOKENS
      ? Number(env.AGENT_MAX_TOTAL_TOKENS)
      : 12_000,
    timeoutMs: env.AGENT_TIMEOUT_MS ? Number(env.AGENT_TIMEOUT_MS) : 30_000,
    temperature: env.AGENT_TEMPERATURE ? Number(env.AGENT_TEMPERATURE) : 0.1,
  });
}
