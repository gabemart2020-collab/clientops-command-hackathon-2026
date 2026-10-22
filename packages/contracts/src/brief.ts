import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { DeliveryHealthStatusSchema } from './health.js';
import { ModelActionProposalInputSchema } from './action.js';

export const AgentBriefFindingSchema = z.object({
  statement: z.string(),
  evidence: z
    .array(EvidenceRefSchema)
    .min(1, 'A finding must include at least one evidence reference'),
});
export type AgentBriefFinding = z.infer<typeof AgentBriefFindingSchema>;

export const AgentBriefAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type AgentBriefAccount = z.infer<typeof AgentBriefAccountSchema>;

export const AgentBriefMeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  scheduledAt: z.string(),
});
export type AgentBriefMeeting = z.infer<typeof AgentBriefMeetingSchema>;

export const AgentBriefModeSchema = z.enum([
  'operational',
  'action_proposal',
  'capability_refusal',
]);
export type AgentBriefMode = z.infer<typeof AgentBriefModeSchema>;

/**
 * Validates cross-field invariants between brief mode and proposedAction:
 * - operational: proposedAction MUST be absent
 * - capability_refusal: proposedAction MUST be absent
 * - action_proposal: proposedAction MUST be present with actionType task.create,
 *   and answer MUST state that the task was NOT created/executed and requires human approval.
 */
export function validateProposedActionModeInvariant(
  data: {
    mode?: AgentBriefMode | undefined;
    proposedAction?: { actionType?: string } | null | undefined;
    answer?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const mode = data.mode ?? 'operational';

  if (mode === 'operational') {
    if (data.proposedAction != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedAction'],
        message: 'proposedAction must be absent in operational mode.',
      });
    }
  } else if (mode === 'capability_refusal') {
    if (data.proposedAction != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedAction'],
        message: 'proposedAction must be absent in capability_refusal mode.',
      });
    }
  } else if (mode === 'action_proposal') {
    if (data.proposedAction == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedAction'],
        message: 'proposedAction is required in action_proposal mode.',
      });
    } else if (data.proposedAction.actionType !== 'task.create') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedAction', 'actionType'],
        message:
          'Only task.create actionType is supported in action_proposal mode.',
      });
    }

    const answer =
      typeof data.answer === 'string' ? data.answer.toLowerCase() : '';

    // answer MUST clearly say the task was NOT created/executed
    const mentionsNotExecuted =
      /\b(not|no|never)\b.*?\b(created|executed|performed|run|applied)\b|\b(has not been|was not|were not|is not)\b.*?\b(created|executed)\b|\b(unexecuted|not yet created|pending execution|not created|not executed)\b/i.test(
        answer,
      );

    if (!mentionsNotExecuted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer'],
        message:
          'In action_proposal mode, answer must clearly state that the task was NOT created or executed.',
      });
    }

    // answer MUST state human approval is required
    const mentionsApprovalRequired =
      /\b(approval|approve|approver)\b/i.test(answer) &&
      /\b(human|operator|admin|required|must|needs|pending|awaiting)\b/i.test(
        answer,
      );

    if (!mentionsApprovalRequired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer'],
        message:
          'In action_proposal mode, answer must state that human approval is required.',
      });
    }
  }
}

export const AgentBriefRawSchema = z.object({
  mode: AgentBriefModeSchema.optional().default('operational'),
  refusalReason: z.string().optional(),
  answer: z.string(),
  account: AgentBriefAccountSchema.optional(),
  meeting: AgentBriefMeetingSchema.optional(),
  health: DeliveryHealthStatusSchema.optional(),
  findings: z.array(AgentBriefFindingSchema),
  suggestedNextSteps: z.array(z.string()),
  proposedAction: ModelActionProposalInputSchema.optional().nullable(),
});
export type AgentBrief = z.infer<typeof AgentBriefRawSchema>;
export const AgentBriefSchema = Object.assign(
  AgentBriefRawSchema.superRefine(validateProposedActionModeInvariant),
  { shape: AgentBriefRawSchema.shape },
);

export const AgentModelFindingSchema = z.object({
  statement: z.string(),
  evidence: z
    .array(
      z.object({
        entityType: z.enum([
          'milestone',
          'task',
          'commitment',
          'communication',
          'decision',
          'meeting',
          'project',
          'client',
        ]),
        entityId: z.string().uuid(),
        field: z.string().optional(),
      }),
    )
    .min(1, 'A finding must include at least one evidence citation'),
});
export type AgentModelFinding = z.infer<typeof AgentModelFindingSchema>;

export const AgentModelOutputRawSchema = z.object({
  mode: AgentBriefModeSchema.optional()
    .default('operational')
    .describe(
      'Mode of the brief: "operational" for answering queries or preparing briefings, "action_proposal" when proposing a controlled task.create action for human approval, "capability_refusal" when refusing unsupported write/mutation actions.',
    ),
  refusalReason: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Explanation of why the action was refused if mode is capability_refusal.',
    ),
  answer: z
    .string()
    .describe(
      'Overarching concise factual answer summarizing the operational posture, proposed action, or refusal.',
    ),
  account: AgentBriefAccountSchema.optional()
    .nullable()
    .describe(
      'Identified client account details. MUST ONLY be included if an authoritative account fact was returned by an MCP tool. Omit or set to null otherwise.',
    ),
  meeting: AgentBriefMeetingSchema.optional()
    .nullable()
    .describe(
      'Identified target meeting details. MUST ONLY be included if an authoritative meeting fact was returned by an MCP tool. Omit or set to null otherwise.',
    ),
  health: DeliveryHealthStatusSchema.nullable()
    .optional()
    .describe(
      'Deterministic delivery health evaluated strictly and exclusively by an authorized health MCP tool (project.assess_delivery_health or meeting.prepare_brief). If neither tool was called during this request, this property MUST be omitted or set to null. NEVER infer, estimate, or guess health from activity logs, communications, or general sentiment.',
    ),
  findings: z
    .array(AgentModelFindingSchema)
    .describe(
      'Key factual findings grounded directly in tool output records. In capability_refusal mode, this MUST be an empty array ([]).',
    ),
  suggestedNextSteps: z
    .array(z.string())
    .describe(
      'Concrete, actionable recommendations or follow-ups for human operators.',
    ),
  proposedAction: ModelActionProposalInputSchema.optional()
    .nullable()
    .describe(
      'Optional grounded action proposal (e.g. task.create) citing authoritative evidence sources. The model NEVER executes or approves actions.',
    ),
});
export type AgentModelOutput = z.infer<typeof AgentModelOutputRawSchema>;
export const AgentModelOutputSchema = Object.assign(
  AgentModelOutputRawSchema.superRefine(validateProposedActionModeInvariant),
  { shape: AgentModelOutputRawSchema.shape },
);
