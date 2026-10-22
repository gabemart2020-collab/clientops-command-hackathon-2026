import * as z from 'zod';
import { ClientIdentitySchema } from './account.js';
import { ActivityItemSchema } from './activity.js';
import { CommitmentSchema } from './commitment.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  AssessDeliveryHealthOutputSchema,
  RiskFindingSchema,
} from './health.js';

export const MeetingDetailsSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().min(1),
  scheduledAt: z.string().datetime(),
  status: z.string().min(1),
  summary: z.string().optional(),
});
export type MeetingDetails = z.infer<typeof MeetingDetailsSchema>;

export const PrepareBriefInputSchema = z.strictObject({
  meeting_id: z.string().uuid(),
});
export type PrepareBriefInput = z.infer<typeof PrepareBriefInputSchema>;

export const PrepareBriefOutputSchema = z.strictObject({
  meeting: MeetingDetailsSchema,
  client: ClientIdentitySchema,
  projectStatus: AssessDeliveryHealthOutputSchema.optional(),
  recentActivity: z.array(ActivityItemSchema),
  openCommitments: z.array(CommitmentSchema),
  riskFindings: z.array(RiskFindingSchema),
  talkingPoints: z.array(z.string().min(1)),
  evidence: z.array(EvidenceRefSchema),
});
export type PrepareBriefOutput = z.infer<typeof PrepareBriefOutputSchema>;
