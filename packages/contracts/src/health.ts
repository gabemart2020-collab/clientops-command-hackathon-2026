import * as z from 'zod';
import { EvidenceRefSchema } from './evidence.js';

export const DeliveryHealthStatusSchema = z.enum([
  'on_track',
  'watch',
  'at_risk',
]);
export type DeliveryHealthStatus = z.infer<typeof DeliveryHealthStatusSchema>;

export const RiskSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

export const RiskCategorySchema = z.enum([
  'milestone_overdue',
  'unresolved_question',
  'task_overdue',
  'commitment_overdue',
]);
export type RiskCategory = z.infer<typeof RiskCategorySchema>;

export const RiskFindingSchema = z.strictObject({
  id: z.string().min(1),
  category: RiskCategorySchema,
  severity: RiskSeveritySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: EvidenceRefSchema,
});
export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const AssessDeliveryHealthInputSchema = z.strictObject({
  project_id: z.string().uuid(),
});
export type AssessDeliveryHealthInput = z.infer<
  typeof AssessDeliveryHealthInputSchema
>;

export const AssessDeliveryHealthOutputSchema = z.strictObject({
  projectId: z.string().uuid(),
  clientId: z.string().uuid(),
  health: DeliveryHealthStatusSchema,
  findings: z.array(RiskFindingSchema),
  evidence: z.array(EvidenceRefSchema),
  evaluatedAt: z.string().datetime(),
});
export type AssessDeliveryHealthOutput = z.infer<
  typeof AssessDeliveryHealthOutputSchema
>;
