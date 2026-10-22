import * as z from 'zod';
import { CommitmentSchema } from './commitment.js';

export const ClientIdentitySchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  industry: z.string().min(1),
  tier: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type ClientIdentity = z.infer<typeof ClientIdentitySchema>;

export const ProjectSummarySchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  status: z.string().min(1),
  targetCompletionAt: z.string().datetime().optional(),
  leadUserId: z.string().uuid().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const UpcomingMeetingSummarySchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().min(1),
  scheduledAt: z.string().datetime(),
  status: z.string().min(1),
  projectId: z.string().uuid().optional(),
});
export type UpcomingMeetingSummary = z.infer<
  typeof UpcomingMeetingSummarySchema
>;

export const AccountCountsSchema = z.strictObject({
  openTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
  openMilestones: z.number().int().nonnegative(),
  overdueMilestones: z.number().int().nonnegative(),
  openCommitments: z.number().int().nonnegative(),
});
export type AccountCounts = z.infer<typeof AccountCountsSchema>;

export const GetAccountContextInputSchema = z.strictObject({
  account_ref: z.string().min(1),
});
export type GetAccountContextInput = z.infer<
  typeof GetAccountContextInputSchema
>;

export const GetAccountContextOutputSchema = z.strictObject({
  client: ClientIdentitySchema,
  activeProjects: z.array(ProjectSummarySchema),
  upcomingMeetings: z.array(UpcomingMeetingSummarySchema),
  counts: AccountCountsSchema,
  openCommitments: z.array(CommitmentSchema),
});
export type GetAccountContextOutput = z.infer<
  typeof GetAccountContextOutputSchema
>;
