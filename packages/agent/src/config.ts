import { z } from 'zod';

export const AgentRuntimeConfigSchema = z.object({
  awsRegion: z.string().min(1).default('us-east-1'),
  bedrockModelId: z
    .string()
    .min(1)
    .default('us.anthropic.claude-3-5-sonnet-20241022-v2:0'),
  mcpUrl: z.string().url().default('http://127.0.0.1:3001/mcp'),
  maxTurns: z.number().int().positive().default(6),
  maxOutputTokens: z.number().int().positive().default(2000),
  maxTotalTokens: z.number().int().positive().default(12000),
  timeoutMs: z.number().int().positive().default(30000),
  temperature: z.number().min(0).max(1).default(0.1),
});

export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

export function loadAgentConfig(
  overrides: Partial<AgentRuntimeConfig> = {},
): AgentRuntimeConfig {
  const envConfig = {
    awsRegion: process.env.AWS_REGION || undefined,
    bedrockModelId: process.env.BEDROCK_MODEL_ID || undefined,
    mcpUrl: process.env.CLIENTOPS_MCP_URL || undefined,
    maxTurns: process.env.AGENT_MAX_TURNS
      ? Number(process.env.AGENT_MAX_TURNS)
      : undefined,
    maxOutputTokens: process.env.AGENT_MAX_OUTPUT_TOKENS
      ? Number(process.env.AGENT_MAX_OUTPUT_TOKENS)
      : undefined,
    maxTotalTokens: process.env.AGENT_MAX_TOTAL_TOKENS
      ? Number(process.env.AGENT_MAX_TOTAL_TOKENS)
      : undefined,
    timeoutMs: process.env.AGENT_TIMEOUT_MS
      ? Number(process.env.AGENT_TIMEOUT_MS)
      : undefined,
    temperature: process.env.AGENT_TEMPERATURE
      ? Number(process.env.AGENT_TEMPERATURE)
      : undefined,
  };

  const merged = {
    ...envConfig,
    ...overrides,
  };

  // Strip undefined values so Zod defaults take effect
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  );

  return AgentRuntimeConfigSchema.parse(cleaned);
}
