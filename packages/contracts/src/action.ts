import { createHash } from 'node:crypto';
import * as z from 'zod';
import { EvidenceRefSchema, ModelEvidenceCitationSchema } from './evidence.js';

// ============================================================================
// 1. Action Types and Classifications
// ============================================================================

export const ActionTypeSchema = z.enum(['task.create']);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ActionClassSchema = z.enum([
  'READ',
  'ANALYZE',
  'DRAFT',
  'WRITE',
  'EXTERNAL',
  'DESTRUCTIVE',
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const ActionStatusSchema = z.enum([
  'PROPOSED',
  'PENDING_APPROVAL',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

// ============================================================================
// 2. Canonical Action Parameters (task.create)
// ============================================================================

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskCreateParametersSchema = z.strictObject({
  clientId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  assigneeUserId: z.string().uuid().optional(),
  assigneeDisplayName: z.string().max(100).optional(),
  milestoneId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  priority: TaskPrioritySchema.default('medium'),
});
export type TaskCreateParameters = z.infer<typeof TaskCreateParametersSchema>;

export type CanonicalActionParameters = TaskCreateParameters;

/**
 * Canonicalizes an ISO-8601 datetime string to UTC representation with millisecond precision (.000Z).
 * Fails closed for invalid or non-finite date values.
 */
export function canonicalizeIsoDateTime(value: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid ISO datetime string: ${value}`);
  }
  return d.toISOString();
}

/**
 * Compares two optional ISO datetime strings for temporal instant equivalence.
 *
 * Rules:
 * - Both absent (undefined or null) => true
 * - One absent and one present => false
 * - Both present: parse both; require finite timestamps; compare epoch milliseconds.
 */
export function sameOptionalInstant(
  left?: string | null,
  right?: string | null,
): boolean {
  const leftAbsent = left === undefined || left === null;
  const rightAbsent = right === undefined || right === null;

  if (leftAbsent && rightAbsent) {
    return true;
  }
  if (leftAbsent || rightAbsent) {
    return false;
  }

  const leftDate = new Date(left);
  const rightDate = new Date(right);

  const leftTime = leftDate.getTime();
  const rightTime = rightDate.getTime();

  if (isNaN(leftTime) || isNaN(rightTime)) {
    return false;
  }

  return leftTime === rightTime;
}

/**
 * Materializes canonical parameters with all defaults populated before hashing.
 * Canonicalizes optional dueAt to UTC ISO-8601 with millisecond precision (.000Z).
 */
export function materializeTaskCreateParameters(
  raw: unknown,
): TaskCreateParameters {
  const parsed = TaskCreateParametersSchema.parse(raw);
  if (parsed.dueAt !== undefined) {
    parsed.dueAt = canonicalizeIsoDateTime(parsed.dueAt);
  }
  return parsed;
}

/**
 * Deterministically serializes an object into canonical JSON with sorted keys.
 * Omits undefined values and guarantees identical serialization regardless of property order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`,
  );
  return '{' + entries.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hex digest of canonical action parameters.
 */
export function computeCanonicalParameterHash(parameters: unknown): string {
  const canonicalJson = canonicalizeJson(parameters);
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export const Sha256HexSchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    'Must be a 64-character lowercase hex SHA-256 digest',
  );
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

// ============================================================================
// 3. Preconditions (Authoritative updated_at Version Semantics)
// ============================================================================

export const PreconditionEntityTypeSchema = z.enum([
  'client',
  'project',
  'milestone',
  'task',
  'meeting',
  'communication',
  'commitment',
  'decision',
]);
export type PreconditionEntityType = z.infer<
  typeof PreconditionEntityTypeSchema
>;

/**
 * Record version precondition bound to an existing entity's updated_at timestamp.
 * Uses the authoritative schema updated_at column directly; does not invent unsupported counters.
 */
export const RecordVersionPreconditionSchema = z.strictObject({
  entityType: PreconditionEntityTypeSchema,
  entityId: z.string().uuid(),
  versionField: z.literal('updated_at'),
  expectedValue: z.string().datetime(),
});
export type RecordVersionPrecondition = z.infer<
  typeof RecordVersionPreconditionSchema
>;

// ============================================================================
// 4. Approval Authorization Fingerprint / Binding Hash
// ============================================================================

export interface ApprovalBindingPayload {
  readonly organizationId: string;
  readonly actionType: string;
  readonly parameters: unknown;
  readonly preconditions: readonly unknown[];
  readonly expiresAt: string;
}

/**
 * Deterministically sorts an array of preconditions by (entityType, entityId, versionField, expectedValue).
 * Guarantees that semantically identical precondition sets in different input order produce the same hash.
 */
export function canonicalizePreconditions(
  preconditions: readonly unknown[],
): readonly unknown[] {
  return [...preconditions].sort((a, b) => {
    const aObj = (a && typeof a === 'object' ? a : {}) as Record<
      string,
      unknown
    >;
    const bObj = (b && typeof b === 'object' ? b : {}) as Record<
      string,
      unknown
    >;
    const aKey = `${String(aObj.entityType ?? '')}:${String(aObj.entityId ?? '')}:${String(aObj.versionField ?? '')}:${String(aObj.expectedValue ?? '')}`;
    const bKey = `${String(bObj.entityType ?? '')}:${String(bObj.entityId ?? '')}:${String(bObj.versionField ?? '')}:${String(bObj.expectedValue ?? '')}`;
    return aKey.localeCompare(bKey);
  });
}

/**
 * Computes the canonical approval binding hash / authorization fingerprint.
 * SHA-256(canonicalize({ organizationId, actionType, parameters, preconditions, expiresAt }))
 */
export function computeApprovalBindingHash(
  payload: ApprovalBindingPayload,
): string {
  const canonicalJson = canonicalizeJson({
    organizationId: payload.organizationId,
    actionType: payload.actionType,
    parameters: payload.parameters,
    preconditions: canonicalizePreconditions(payload.preconditions),
    expiresAt: payload.expiresAt,
  });
  return createHash('sha256').update(canonicalJson).digest('hex');
}

// ============================================================================
// 5. Citations & Action Proposals
// ============================================================================

/**
 * Untrusted Model Proposal Input.
 * This is what an LLM or user agent is permitted to propose.
 * The model MUST NOT supply organizationId, approval state, parameter hashes,
 * approvalBindingHash, server timestamps, or authoritative evidence excerpts.
 */
export const ModelActionProposalInputSchema = z.strictObject({
  actionType: ActionTypeSchema,
  parameters: TaskCreateParametersSchema,
  justification: z
    .string()
    .min(1, 'A justification is required')
    .max(1000, 'Justification must not exceed 1000 characters'),
  citations: z
    .array(ModelEvidenceCitationSchema)
    .min(
      1,
      'An action proposal must cite at least one authoritative evidence source',
    ),
});
export type ModelActionProposalInput = z.infer<
  typeof ModelActionProposalInputSchema
>;

/**
 * Server-owned ActionProposal.
 * Trusted fields (id, organizationId, parameterHash, approvalBindingHash, status,
 * server-hydrated evidence, timestamps) are strictly derived and owned by the server.
 */
export const ActionProposalBaseSchema = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actionType: ActionTypeSchema,
  actionClass: ActionClassSchema,
  parameters: TaskCreateParametersSchema,
  parameterHash: Sha256HexSchema,
  approvalBindingHash: Sha256HexSchema,
  correlationId: z.string().min(1),
  evidence: z
    .array(EvidenceRefSchema)
    .min(1, 'Action proposal must contain at least one evidence item'),
  preconditions: z
    .array(RecordVersionPreconditionSchema)
    .min(1, 'Action proposal must contain at least one precondition'),
  status: ActionStatusSchema,
  justification: z.string().min(1).max(1000),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export const ActionProposalSchema = ActionProposalBaseSchema.superRefine(
  (val, ctx) => {
    if (val.actionType === 'task.create') {
      const hasProjectPrecondition = val.preconditions.some(
        (p) =>
          p.entityType === 'project' &&
          p.versionField === 'updated_at' &&
          p.entityId === val.parameters.projectId,
      );
      if (!hasProjectPrecondition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Proposal for task.create must include an updated_at precondition for target project ${val.parameters.projectId}`,
          path: ['preconditions'],
        });
      }
    }
  },
);
export type ActionProposal = z.infer<typeof ActionProposalBaseSchema>;

/**
 * CreateActionProposalInputSchema.
 * Strictly enforces that initial proposal status on creation is 'PROPOSED'.
 */
export const CreateActionProposalInputSchema = ActionProposalBaseSchema.extend({
  status: z.literal('PROPOSED').default('PROPOSED'),
}).superRefine((val, ctx) => {
  if (val.actionType === 'task.create') {
    const hasProjectPrecondition = val.preconditions.some(
      (p) =>
        p.entityType === 'project' &&
        p.versionField === 'updated_at' &&
        p.entityId === val.parameters.projectId,
    );
    if (!hasProjectPrecondition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Proposal for task.create must include an updated_at precondition for target project ${val.parameters.projectId}`,
        path: ['preconditions'],
      });
    }
  }
});
export type CreateActionProposalInput = z.infer<
  typeof CreateActionProposalInputSchema
>;

// ============================================================================
// 6. Policy Decisions
// ============================================================================

export const PolicyDecisionTypeSchema = z.enum([
  'AUTOMATIC_ALLOW',
  'REQUIRES_APPROVAL',
  'DENIED',
]);
export type PolicyDecisionType = z.infer<typeof PolicyDecisionTypeSchema>;

export const PolicyDecisionSchema = z.strictObject({
  decision: PolicyDecisionTypeSchema,
  actionType: z.string(),
  actionClass: ActionClassSchema,
  reason: z.string().min(1),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// ============================================================================
// 7. Trusted Actor Context & Approvals
// ============================================================================

export const ActorRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

export const TrustedActorRoleSchema = z.enum(['admin', 'operator']);
export type TrustedActorRole = z.infer<typeof TrustedActorRoleSchema>;

export const ActorSourceSchema = z.enum([
  'session',
  'jwt',
  'local_demo_adapter',
]);
export type ActorSource = z.infer<typeof ActorSourceSchema>;

export const TrustedActorContextSchema = z.strictObject({
  organizationId: z.string().uuid(),
  actorId: z.string().uuid(),
  role: ActorRoleSchema,
  source: ActorSourceSchema,
  isProductionActor: z.boolean(),
});
export type TrustedActorContext = z.infer<typeof TrustedActorContextSchema>;

export const ApprovalDecisionSchema = z.enum(['APPROVE', 'DENY']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRecordSchema = z.strictObject({
  id: z.string().uuid(),
  actionProposalId: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorId: z.string().uuid(),
  actorRole: TrustedActorRoleSchema,
  decision: ApprovalDecisionSchema,
  decidedAt: z.string().datetime(),
  parameterHash: Sha256HexSchema,
  approvalBindingHash: Sha256HexSchema,
  validUntil: z.string().datetime(),
  comment: z.string().max(500).optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/**
 * Strict request contract for human approval / denial decision.
 * The browser must NEVER supply organizationId, actorId, role, hashes, or timestamps.
 */
export const ApprovalDecisionRequestSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
  comment: z.string().max(500).optional(),
});
export type ApprovalDecisionRequest = z.infer<
  typeof ApprovalDecisionRequestSchema
>;

export const ExecutionAuthorizationSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  organizationId: z.string().uuid(),
  approvedByActorId: z.string().uuid(),
  parameterHash: Sha256HexSchema,
  approvalBindingHash: Sha256HexSchema,
  approvedAt: z.string().datetime(),
  validUntil: z.string().datetime(),
});
export type ExecutionAuthorization = z.infer<
  typeof ExecutionAuthorizationSchema
>;

// ============================================================================
// 8. Execution Results (Idempotency Tracking)
// ============================================================================

export const ActionExecutionStatusSchema = z.enum([
  'EXECUTING',
  'COMPLETED',
  'FAILED',
]);
export type ActionExecutionStatus = z.infer<typeof ActionExecutionStatusSchema>;

export const TRUSTED_EXECUTOR_PRINCIPAL = 'clientops_trusted_executor' as const;
export const ExecutorPrincipalSchema = z
  .literal('clientops_trusted_executor')
  .default('clientops_trusted_executor');
export type ExecutorPrincipal = z.infer<typeof ExecutorPrincipalSchema>;

export const ExecutionErrorCodeSchema = z.enum([
  'PRECONDITION_FAILED',
  'APPROVAL_EXPIRED',
  'APPROVAL_BINDING_MISMATCH',
  'TENANT_MISMATCH',
  'TASK_CREATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_EXECUTION_ERROR',
]);
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;

export const SAFE_FAILURE_SUMMARIES: Record<ExecutionErrorCode, string> = {
  PRECONDITION_FAILED:
    'A record version precondition was not met at execution time.',
  APPROVAL_EXPIRED: 'The action approval expired prior to execution.',
  APPROVAL_BINDING_MISMATCH: 'Approval authorization binding hash mismatch.',
  TENANT_MISMATCH: 'Tenant context does not match the approved proposal.',
  TASK_CREATION_FAILED:
    'Task creation business validation or database insertion failed.',
  IDEMPOTENCY_CONFLICT: 'An execution record already exists for this proposal.',
  INTERNAL_EXECUTION_ERROR:
    'Task creation failed due to an internal execution error.',
};

export interface SafeFailureResolution {
  readonly errorCode: ExecutionErrorCode;
  readonly failureSummary: string;
}

/**
 * Resolves a safe, bounded failure summary for durable persistence.
 * Raw caught Error.message / provider response / SQL message is NOT the normal durable failure_summary source.
 * Known failures map to stable error codes and safe predefined summaries.
 * Unknown failures map to INTERNAL_EXECUTION_ERROR with predefined generic summary.
 * sanitizeFailureSummary remains defense-in-depth.
 */
export function resolveSafeFailureSummary(
  errorCode?: unknown,
  rawMessage?: unknown,
): SafeFailureResolution {
  void rawMessage;
  const parsed = ExecutionErrorCodeSchema.safeParse(errorCode);
  if (parsed.success) {
    return {
      errorCode: parsed.data,
      failureSummary: SAFE_FAILURE_SUMMARIES[parsed.data],
    };
  }
  return {
    errorCode: 'INTERNAL_EXECUTION_ERROR',
    failureSummary: SAFE_FAILURE_SUMMARIES.INTERNAL_EXECUTION_ERROR,
  };
}

export const ActionExecutionRecordSchema = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actionProposalId: z.string().uuid(),
  actionApprovalId: z.string().uuid(),
  executorPrincipal: ExecutorPrincipalSchema,
  status: ActionExecutionStatusSchema,
  targetEntityType: z.string().default('task'),
  targetEntityId: z.string().uuid().optional(),
  parameterHash: Sha256HexSchema,
  approvalBindingHash: Sha256HexSchema,
  errorCode: ExecutionErrorCodeSchema.optional(),
  failureSummary: z.string().max(500).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type ActionExecutionRecord = z.infer<typeof ActionExecutionRecordSchema>;

export const ExecutionStatusSchema = z.enum(['COMPLETED', 'FAILED']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionResultSchema = z.strictObject({
  executionId: z.string().uuid(),
  actionProposalId: z.string().uuid(),
  organizationId: z.string().uuid(),
  status: ExecutionStatusSchema,
  executedAt: z.string().datetime(),
  resultEntityId: z.string().uuid().optional(),
  failureSummary: z.string().max(500).optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

/**
 * Sanitizes failure information into a bounded, safe failure summary (max 500 characters).
 * Strips stack traces, redacts filesystem paths, tokens/passwords/secrets, and collapses whitespace.
 */
export function sanitizeFailureSummary(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let msg: string;
  if (raw instanceof Error) {
    msg = raw.message;
  } else if (typeof raw === 'string') {
    msg = raw;
  } else if (typeof raw === 'object') {
    try {
      msg = JSON.stringify(raw);
    } catch {
      msg = String(raw);
    }
  } else {
    msg = String(raw);
  }

  // Strip stack traces (lines containing " at ...")
  msg = msg.replace(/\s+at\s+.*(?:\r?\n|$)/g, ' ');

  // Redact potential bearer tokens, api keys, passwords
  msg = msg.replace(/(?:bearer\s+[a-zA-Z0-9_\-.]+)/gi, '[REDACTED_TOKEN]');
  msg = msg.replace(
    /(password|secret|key|token|auth|credential)[=:\s]+[^\s,;]+/gi,
    '$1=[REDACTED]',
  );
  msg = msg.replace(
    /postgres(?:ql)?:\/\/[^\s@]+@[^\s/]+/gi,
    'postgres://[REDACTED]@host',
  );

  // Redact absolute file paths
  msg = msg.replace(
    /(?:\/(?:home|workspaces|tmp|etc|var|usr|app)[^\s:;,"]*)/gi,
    '[REDACTED_PATH]',
  );
  msg = msg.replace(/[a-zA-Z]:\\[^\s:;,"]+/gi, '[REDACTED_PATH]');

  // Collapse whitespace
  msg = msg.replace(/\s+/g, ' ').trim();

  // Bound to 500 characters
  if (msg.length > 500) {
    msg = msg.slice(0, 497) + '...';
  }

  return msg.length > 0 ? msg : undefined;
}

// ============================================================================
// 9. Strict Event-Specific Audit Payloads (Append-Only)
// ============================================================================

export const AuditEventTypeSchema = z.enum([
  'ACTION_PROPOSED',
  'APPROVAL_REQUESTED',
  'ACTION_APPROVED',
  'ACTION_DENIED',
  'ACTION_EXPIRED',
  'EXECUTION_STARTED',
  'EXECUTION_COMPLETED',
  'EXECUTION_FAILED',
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const ActionProposedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  actionType: ActionTypeSchema,
  actionClass: ActionClassSchema,
  parameterHash: Sha256HexSchema,
  approvalBindingHash: Sha256HexSchema,
  justification: z.string().min(1).max(1000),
  clientId: z.string().uuid(),
  projectId: z.string().uuid(),
  preconditionCount: z.number().int().nonnegative(),
  citationCount: z.number().int().nonnegative(),
});
export type ActionProposedPayload = z.infer<typeof ActionProposedPayloadSchema>;

export const ApprovalRequestedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  approvalBindingHash: Sha256HexSchema,
});
export type ApprovalRequestedPayload = z.infer<
  typeof ApprovalRequestedPayloadSchema
>;

export const ActionApprovedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  actorId: z.string().uuid(),
  actorRole: TrustedActorRoleSchema,
  decidedAt: z.string().datetime(),
  approvalBindingHash: Sha256HexSchema,
  comment: z.string().max(500).optional(),
});
export type ActionApprovedPayload = z.infer<typeof ActionApprovedPayloadSchema>;

export const ActionDeniedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  actorId: z.string().uuid(),
  actorRole: TrustedActorRoleSchema,
  decidedAt: z.string().datetime(),
  reason: z.string().max(500),
});
export type ActionDeniedPayload = z.infer<typeof ActionDeniedPayloadSchema>;

export const ActionExpiredPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  expiredAt: z.string().datetime(),
  previousStatus: ActionStatusSchema,
});
export type ActionExpiredPayload = z.infer<typeof ActionExpiredPayloadSchema>;

export const ExecutionStartedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  executionId: z.string().uuid(),
  executorPrincipal: ExecutorPrincipalSchema,
  startedAt: z.string().datetime(),
  approvalBindingHash: Sha256HexSchema,
});
export type ExecutionStartedPayload = z.infer<
  typeof ExecutionStartedPayloadSchema
>;

export const ExecutionCompletedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  executionId: z.string().uuid(),
  targetEntityType: z.literal('task'),
  targetEntityId: z.string().uuid(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type ExecutionCompletedPayload = z.infer<
  typeof ExecutionCompletedPayloadSchema
>;

export const ExecutionFailedPayloadSchema = z.strictObject({
  actionProposalId: z.string().uuid(),
  executionId: z.string().uuid(),
  errorCode: ExecutionErrorCodeSchema,
  failureSummary: z.string().min(1).max(500),
  failedAt: z.string().datetime(),
});
export type ExecutionFailedPayload = z.infer<
  typeof ExecutionFailedPayloadSchema
>;

export const AuditEventPayloadSchema = z.union([
  ActionProposedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ActionApprovedPayloadSchema,
  ActionDeniedPayloadSchema,
  ActionExpiredPayloadSchema,
  ExecutionStartedPayloadSchema,
  ExecutionCompletedPayloadSchema,
  ExecutionFailedPayloadSchema,
]);
export type AuditEventPayload = z.infer<typeof AuditEventPayloadSchema>;

const BaseAuditEventFields = {
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actionProposalId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  parameterHash: Sha256HexSchema.optional(),
  approvalBindingHash: Sha256HexSchema.optional(),
  correlationId: z.string().optional(),
  occurredAt: z.string().datetime(),
};

export const ActionProposedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('ACTION_PROPOSED'),
    payload: ActionProposedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
    if (
      val.approvalBindingHash !== undefined &&
      val.approvalBindingHash !== val.payload.approvalBindingHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level approvalBindingHash must match payload approvalBindingHash`,
        path: ['approvalBindingHash'],
      });
    }
  });
export type ActionProposedAuditEvent = z.infer<
  typeof ActionProposedAuditEventSchema
>;

export const ApprovalRequestedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('APPROVAL_REQUESTED'),
    payload: ApprovalRequestedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
    if (
      val.approvalBindingHash !== undefined &&
      val.approvalBindingHash !== val.payload.approvalBindingHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level approvalBindingHash must match payload approvalBindingHash`,
        path: ['approvalBindingHash'],
      });
    }
  });
export type ApprovalRequestedAuditEvent = z.infer<
  typeof ApprovalRequestedAuditEventSchema
>;

export const ActionApprovedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('ACTION_APPROVED'),
    payload: ActionApprovedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
    if (val.actorId !== undefined && val.actorId !== val.payload.actorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actorId '${val.actorId}' must match payload actorId '${val.payload.actorId}'`,
        path: ['actorId'],
      });
    }
    if (
      val.approvalBindingHash !== undefined &&
      val.approvalBindingHash !== val.payload.approvalBindingHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level approvalBindingHash must match payload approvalBindingHash`,
        path: ['approvalBindingHash'],
      });
    }
  });
export type ActionApprovedAuditEvent = z.infer<
  typeof ActionApprovedAuditEventSchema
>;

export const ActionDeniedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('ACTION_DENIED'),
    payload: ActionDeniedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
    if (val.actorId !== undefined && val.actorId !== val.payload.actorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actorId '${val.actorId}' must match payload actorId '${val.payload.actorId}'`,
        path: ['actorId'],
      });
    }
  });
export type ActionDeniedAuditEvent = z.infer<
  typeof ActionDeniedAuditEventSchema
>;

export const ActionExpiredAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('ACTION_EXPIRED'),
    payload: ActionExpiredPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
  });
export type ActionExpiredAuditEvent = z.infer<
  typeof ActionExpiredAuditEventSchema
>;

export const ExecutionStartedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('EXECUTION_STARTED'),
    payload: ExecutionStartedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
    if (
      val.approvalBindingHash !== undefined &&
      val.approvalBindingHash !== val.payload.approvalBindingHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level approvalBindingHash must match payload approvalBindingHash`,
        path: ['approvalBindingHash'],
      });
    }
  });
export type ExecutionStartedAuditEvent = z.infer<
  typeof ExecutionStartedAuditEventSchema
>;

export const ExecutionCompletedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('EXECUTION_COMPLETED'),
    payload: ExecutionCompletedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
  });
export type ExecutionCompletedAuditEvent = z.infer<
  typeof ExecutionCompletedAuditEventSchema
>;

export const ExecutionFailedAuditEventSchema = z
  .strictObject({
    ...BaseAuditEventFields,
    eventType: z.literal('EXECUTION_FAILED'),
    payload: ExecutionFailedPayloadSchema,
  })
  .superRefine((val, ctx) => {
    if (
      val.actionProposalId !== undefined &&
      val.actionProposalId !== val.payload.actionProposalId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Top-level actionProposalId '${val.actionProposalId}' must match payload actionProposalId '${val.payload.actionProposalId}'`,
        path: ['actionProposalId'],
      });
    }
  });
export type ExecutionFailedAuditEvent = z.infer<
  typeof ExecutionFailedAuditEventSchema
>;

export const AuditEventSchema = z.discriminatedUnion('eventType', [
  ActionProposedAuditEventSchema,
  ApprovalRequestedAuditEventSchema,
  ActionApprovedAuditEventSchema,
  ActionDeniedAuditEventSchema,
  ActionExpiredAuditEventSchema,
  ExecutionStartedAuditEventSchema,
  ExecutionCompletedAuditEventSchema,
  ExecutionFailedAuditEventSchema,
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
