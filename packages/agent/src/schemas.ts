import { z } from 'zod';
import {
  AgentBriefSchema,
  AgentModelOutputSchema,
  EvidenceRefSchema,
  type AgentBrief,
  type AgentModelOutput,
  type EvidenceRef,
  type ModelEvidenceCitation,
} from '@clientops/contracts';

export {
  AgentBriefSchema,
  AgentModelOutputSchema,
  type AgentBrief,
  type AgentModelOutput,
};

export const ToolExecutionTraceSchema = z.object({
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  durationMs: z.number(),
  status: z.enum(['ok', 'error']),
  errorMessage: z.string().optional(),
  evidenceReferences: z.array(EvidenceRefSchema),
});
export type ToolExecutionTrace = z.infer<typeof ToolExecutionTraceSchema>;

export const GroundingValidationResultSchema = z.object({
  valid: z.boolean(),
  groundedEvidenceCount: z.number().int().nonnegative(),
  unsupportedEvidenceCount: z.number().int().nonnegative(),
  authoritativeEvidenceCount: z.number().int().nonnegative(),
  unsupportedReferences: z.array(EvidenceRefSchema),
  message: z.string().optional(),
});
export type GroundingValidationResult = z.infer<
  typeof GroundingValidationResultSchema
>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RegisteredActionProposalSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.string(),
  reviewUrl: z.string(),
});
export type RegisteredActionProposal = z.infer<
  typeof RegisteredActionProposalSchema
>;

export const AgentRunResultSchema = z.object({
  success: z.boolean(),
  brief: AgentBriefSchema.optional(),
  rawText: z.string().optional(),
  toolTrace: z.array(ToolExecutionTraceSchema),
  modelId: z.string(),
  stopReason: z.string(),
  latencyMs: z.number().nonnegative(),
  tokenUsage: TokenUsageSchema.optional(),
  grounding: GroundingValidationResultSchema,
  actionProposal: RegisteredActionProposalSchema.optional(),
  error: z.string().optional(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema> & {
  evidenceResolver?: {
    resolveCitation: (citation: EvidenceRef | ModelEvidenceCitation) => {
      success: boolean;
      resolved?: EvidenceRef;
      error?: string;
    };
  };
};

export const AgentBriefRequestSchema = z.object({
  userMessage: z.string().min(1),
  accountHint: z.string().optional(),
});
export type AgentBriefRequest = z.infer<typeof AgentBriefRequestSchema>;
