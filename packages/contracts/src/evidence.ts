import * as z from 'zod';

export const EvidenceEntityTypeSchema = z.enum([
  'milestone',
  'task',
  'commitment',
  'communication',
  'decision',
  'meeting',
  'project',
  'client',
]);
export type EvidenceEntityType = z.infer<typeof EvidenceEntityTypeSchema>;

export const EvidenceRefSchema = z.strictObject({
  entityType: EvidenceEntityTypeSchema,
  entityId: z.string().uuid(),
  field: z.string().optional(),
  excerpt: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const EvidenceCitationSchema = z.strictObject({
  entityType: EvidenceEntityTypeSchema,
  entityId: z.string().uuid(),
  field: z.string().optional(),
  excerpt: z.string().optional(),
});
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;

export const ModelEvidenceCitationSchema = z.strictObject({
  entityType: EvidenceEntityTypeSchema,
  entityId: z.string().uuid(),
  field: z.string().optional(),
});
export type ModelEvidenceCitation = z.infer<typeof ModelEvidenceCitationSchema>;
