import * as z from 'zod';
import { EvidenceRefSchema } from './evidence.js';

export const ActivityTypeSchema = z.enum([
  'communication',
  'task_completed',
  'milestone_updated',
  'decision',
  'meeting',
]);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const ActivityItemSchema = z.strictObject({
  id: z.string().uuid(),
  type: ActivityTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  occurredAt: z.string().datetime(),
  evidenceRef: EvidenceRefSchema,
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const RecentActivityInputSchema = z.strictObject({
  client_id: z.string().uuid(),
  lookback_days: z.number().int().min(1).max(90).default(14),
});
export type RecentActivityInput = z.infer<typeof RecentActivityInputSchema>;

export const RecentActivityOutputSchema = z.strictObject({
  clientId: z.string().uuid(),
  lookbackDays: z.number().int().min(1).max(90),
  items: z.array(ActivityItemSchema),
});
export type RecentActivityOutput = z.infer<typeof RecentActivityOutputSchema>;
