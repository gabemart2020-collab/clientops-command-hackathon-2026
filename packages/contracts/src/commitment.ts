import * as z from 'zod';
import { EvidenceRefSchema } from './evidence.js';

export const CommitmentStatusSchema = z.enum([
  'open',
  'fulfilled',
  'cancelled',
]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const CommitmentOwnerSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
});
export type CommitmentOwner = z.infer<typeof CommitmentOwnerSchema>;

export const CommitmentSchema = z.strictObject({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  description: z.string().min(1),
  owner: CommitmentOwnerSchema,
  dueAt: z.string().datetime(),
  status: CommitmentStatusSchema,
  fulfilledAt: z.string().datetime().optional(),
  originatingEvidence: EvidenceRefSchema.optional(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const ListOpenCommitmentsInputSchema = z.strictObject({
  client_id: z.string().uuid(),
});
export type ListOpenCommitmentsInput = z.infer<
  typeof ListOpenCommitmentsInputSchema
>;

export const ListOpenCommitmentsOutputSchema = z.strictObject({
  clientId: z.string().uuid(),
  commitments: z.array(CommitmentSchema),
});
export type ListOpenCommitmentsOutput = z.infer<
  typeof ListOpenCommitmentsOutputSchema
>;
