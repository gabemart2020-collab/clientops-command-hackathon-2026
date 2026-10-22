import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  ActionProposedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ActionApprovedPayloadSchema,
  ActionDeniedPayloadSchema,
  ActionExpiredPayloadSchema,
  ExecutionStartedPayloadSchema,
  ExecutionCompletedPayloadSchema,
  ExecutionFailedPayloadSchema,
  type AuditEvent,
  type AuditEventType,
  type ActionProposedPayload,
  type ApprovalRequestedPayload,
  type ActionApprovedPayload,
  type ActionDeniedPayload,
  type ActionExpiredPayload,
  type ExecutionStartedPayload,
  type ExecutionCompletedPayload,
  type ExecutionFailedPayload,
  type AuditEventPayload,
} from '@clientops/contracts';

/**
 * Forbidden keys that must NEVER be written to audit payloads.
 */
export const FORBIDDEN_AUDIT_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'secret_key',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'credentials',
  'aws_secret_access_key',
  'aws_session_token',
  'awssecretaccesskey',
  'awssessiontoken',
  'cookie',
  'set-cookie',
]);

/**
 * Maximum string length allowed for scalar values in audit metadata.
 * Prevents storing unbounded prompts, full transcripts, or massive error stacks.
 */
export const MAX_AUDIT_STRING_LENGTH = 500;

/**
 * Sanitizes a string value against credentials, tokens, DB URLs, filesystem paths, and stacks.
 */
export function sanitizeAuditString(raw: string): string {
  let text = raw;

  // Strip stack traces
  text = text.replace(/\s+at\s+.*(?:\r?\n|$)/g, ' ');

  // Redact potential bearer tokens
  text = text.replace(/(?:bearer\s+[a-zA-Z0-9_\-.]+)/gi, '[REDACTED_TOKEN]');

  // Redact Basic authorization credentials
  text = text.replace(
    /(?:authorization:\s*)?basic\s+[a-zA-Z0-9+/=]{6,}/gi,
    '[REDACTED_AUTH]',
  );

  // Redact AWS access keys (AKIA..., ASIA...)
  text = text.replace(
    /(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g,
    '[REDACTED_AWS_KEY]',
  );

  // Redact AWS secret access keys / session tokens / secrets
  text = text.replace(
    /(?:aws_secret_access_key|aws_session_token|secret_key)[\s=:]+[^\s,;]+/gi,
    'aws_secret_key=[REDACTED]',
  );

  // Redact passwords, credentials, api keys, tokens in key-value form
  text = text.replace(
    /(password|secret|api[_-]?key|token|auth|credential)[=:\s]+[^\s,;]+/gi,
    '$1=[REDACTED]',
  );

  // Redact quoted JSON secret forms: {"password":"..."}, {"token":"..."}, etc.
  text = text.replace(
    /"(password|token|credential|secret|api[_-]?key|access_token|refresh_token)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"',
  );

  // Redact PostgreSQL and generic DB connection URLs
  text = text.replace(
    /postgres(?:ql)?:\/\/[^\s@]+@[^\s/]+/gi,
    'postgres://[REDACTED]@host',
  );

  // Redact internal filesystem paths
  text = text.replace(
    /(?:\/(?:home|workspaces|tmp|etc|var|usr|app)[^\s:;,"]*)/gi,
    '[REDACTED_PATH]',
  );
  text = text.replace(/[a-zA-Z]:\\[^\s:;,"]+/gi, '[REDACTED_PATH]');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Bound length to MAX_AUDIT_STRING_LENGTH
  const truncationSuffix = '... [TRUNCATED]';
  if (text.length > MAX_AUDIT_STRING_LENGTH) {
    text =
      text.slice(
        0,
        Math.max(0, MAX_AUDIT_STRING_LENGTH - truncationSuffix.length),
      ) + truncationSuffix;
  }

  return text;
}

/**
 * Sanitizes untrusted human approval comments before persistence or audit event construction.
 * Redacts secrets, tokens, credentials, AWS keys, JSON secret shapes, DB URLs, filesystem paths,
 * and bounds string length to 500 characters.
 */
export function sanitizeApprovalComment(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const sanitized = sanitizeAuditString(raw);
  if (!sanitized) {
    return undefined;
  }
  return sanitized.length > 500 ? sanitized.slice(0, 500) : sanitized;
}

/**
 * Sanitizes and bounds an audit payload.
 *
 * 1. Strips any sensitive credentials or secret keys.
 * 2. Redacts secret-shaped content in allowed string fields (bearer tokens, AWS keys, passwords, DB URLs, file paths).
 * 3. Bounds string lengths to MAX_AUDIT_STRING_LENGTH.
 * 4. Strips Error objects and stack traces (does not persist raw error objects).
 */
export function sanitizeAuditPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(payload)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_AUDIT_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    if (typeof val === 'string') {
      sanitized[key] = sanitizeAuditString(val);
    } else if (val instanceof Error) {
      // Do not log or persist raw Error objects or stack traces
      sanitized[key] = '[ERROR_OBJECT_REDACTED]';
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      sanitized[key] = sanitizeAuditPayload(val as Record<string, unknown>);
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

export type EventPayloadMap = {
  ACTION_PROPOSED: ActionProposedPayload;
  APPROVAL_REQUESTED: ApprovalRequestedPayload;
  ACTION_APPROVED: ActionApprovedPayload;
  ACTION_DENIED: ActionDeniedPayload;
  ACTION_EXPIRED: ActionExpiredPayload;
  EXECUTION_STARTED: ExecutionStartedPayload;
  EXECUTION_COMPLETED: ExecutionCompletedPayload;
  EXECUTION_FAILED: ExecutionFailedPayload;
};

export const EVENT_PAYLOAD_SCHEMAS = {
  ACTION_PROPOSED: ActionProposedPayloadSchema,
  APPROVAL_REQUESTED: ApprovalRequestedPayloadSchema,
  ACTION_APPROVED: ActionApprovedPayloadSchema,
  ACTION_DENIED: ActionDeniedPayloadSchema,
  ACTION_EXPIRED: ActionExpiredPayloadSchema,
  EXECUTION_STARTED: ExecutionStartedPayloadSchema,
  EXECUTION_COMPLETED: ExecutionCompletedPayloadSchema,
  EXECUTION_FAILED: ExecutionFailedPayloadSchema,
} as const;

export interface BuildAuditEventParams<
  T extends AuditEventType = AuditEventType,
> {
  readonly organizationId: string;
  readonly actionProposalId?: string | undefined;
  readonly eventType: T;
  readonly actorId?: string | undefined;
  readonly parameterHash?: string | undefined;
  readonly approvalBindingHash?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly payload: EventPayloadMap[T] | AuditEventPayload;
  readonly occurredAt?: string | undefined;
}

/**
 * Builds a validated, sanitized, append-only AuditEvent.
 * Enforces strict discriminated union validation tying each event type to its designated payload schema.
 * Enforces cross-field equality between top-level identity fields and payload fields.
 */
export function buildAuditEvent<T extends AuditEventType>(
  params: BuildAuditEventParams<T>,
): AuditEvent {
  const payloadSchema = EVENT_PAYLOAD_SCHEMAS[params.eventType];
  if (!payloadSchema) {
    throw new Error(`Unsupported audit event type: ${params.eventType}`);
  }

  const sanitizedPayload = sanitizeAuditPayload(
    params.payload as Record<string, unknown>,
  );
  const validatedPayload = payloadSchema.parse(sanitizedPayload);
  const pRecord = validatedPayload as Record<string, unknown>;

  // Strict cross-field identity verification
  if (
    pRecord.actionProposalId !== undefined &&
    params.actionProposalId !== undefined &&
    params.actionProposalId !== pRecord.actionProposalId
  ) {
    throw new Error(
      `Cross-field identity mismatch: top-level actionProposalId '${params.actionProposalId}' does not match payload actionProposalId '${pRecord.actionProposalId}'`,
    );
  }
  if (
    pRecord.actorId !== undefined &&
    params.actorId !== undefined &&
    params.actorId !== pRecord.actorId
  ) {
    throw new Error(
      `Cross-field identity mismatch: top-level actorId '${params.actorId}' does not match payload actorId '${pRecord.actorId}'`,
    );
  }
  if (
    pRecord.approvalBindingHash !== undefined &&
    params.approvalBindingHash !== undefined &&
    params.approvalBindingHash !== pRecord.approvalBindingHash
  ) {
    throw new Error(
      `Cross-field identity mismatch: top-level approvalBindingHash does not match payload approvalBindingHash`,
    );
  }
  if (
    pRecord.parameterHash !== undefined &&
    params.parameterHash !== undefined &&
    params.parameterHash !== pRecord.parameterHash
  ) {
    throw new Error(
      `Cross-field identity mismatch: top-level parameterHash does not match payload parameterHash`,
    );
  }

  const requiresTopLevelMatching =
    params.eventType === 'ACTION_APPROVED' ||
    params.eventType === 'ACTION_DENIED' ||
    params.eventType === 'APPROVAL_REQUESTED';

  const effectiveActionProposalId =
    params.actionProposalId ??
    (requiresTopLevelMatching
      ? (pRecord.actionProposalId as string | undefined)
      : undefined);
  const effectiveActorId =
    params.actorId ??
    (requiresTopLevelMatching
      ? (pRecord.actorId as string | undefined)
      : undefined);
  const effectiveParameterHash = params.parameterHash;
  const effectiveApprovalBindingHash =
    params.approvalBindingHash ??
    (requiresTopLevelMatching
      ? (pRecord.approvalBindingHash as string | undefined)
      : undefined);

  const event = {
    id: randomUUID(),
    organizationId: params.organizationId,
    eventType: params.eventType,
    payload: validatedPayload,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    ...(effectiveActionProposalId !== undefined
      ? { actionProposalId: effectiveActionProposalId }
      : {}),
    ...(effectiveActorId !== undefined ? { actorId: effectiveActorId } : {}),
    ...(effectiveParameterHash !== undefined
      ? { parameterHash: effectiveParameterHash }
      : {}),
    ...(effectiveApprovalBindingHash !== undefined
      ? { approvalBindingHash: effectiveApprovalBindingHash }
      : {}),
    ...(params.correlationId !== undefined
      ? { correlationId: params.correlationId }
      : {}),
  };

  return AuditEventSchema.parse(event);
}
