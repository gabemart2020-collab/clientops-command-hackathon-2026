import { ZodError } from 'zod';
import {
  ProposalRegistrationError,
  ProposalEvidenceResolutionError,
} from '@clientops/policy';
import { ActionStoreUnavailableError } from '@/lib/action-context';

export interface PublicToolTraceItem {
  toolName: string;
  status: string;
  durationMs: number;
  evidenceCount: number;
}

/**
 * Sanitizes tool execution trace items for safe public exposure.
 * Strictly excludes raw error messages, stack traces, credentials, and raw arguments.
 */
export function sanitizePublicToolTrace(trace: unknown): PublicToolTraceItem[] {
  if (!Array.isArray(trace)) {
    return [];
  }
  return trace.map((item) => {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<
      string,
      unknown
    >;
    const evidenceList = Array.isArray(raw.evidenceReferences)
      ? raw.evidenceReferences
      : [];
    return {
      toolName:
        typeof raw.toolName === 'string' ? raw.toolName : 'unknown_tool',
      status: typeof raw.status === 'string' ? raw.status : 'ok',
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
      evidenceCount: evidenceList.length,
    };
  });
}

/**
 * Deterministically classifies proposal registration errors into bounded allowlisted categories.
 * Guarantees arbitrary Error.name text is never passed to server loggers.
 */
export function classifyProposalErrorType(err: unknown): string {
  if (err instanceof ActionStoreUnavailableError) {
    return 'ACTION_STORE_UNAVAILABLE';
  }
  if (
    err instanceof ProposalRegistrationError ||
    (err instanceof Error && err.name === 'ProposalRegistrationError')
  ) {
    return 'PROPOSAL_REGISTRATION_ERROR';
  }
  if (
    err instanceof ProposalEvidenceResolutionError ||
    (err instanceof Error && err.name === 'ProposalEvidenceResolutionError')
  ) {
    return 'PROPOSAL_REGISTRATION_ERROR';
  }
  if (
    err instanceof ZodError ||
    (err instanceof Error && err.name === 'ZodError')
  ) {
    return 'VALIDATION_ERROR';
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Deterministically redacts sensitive credentials, tokens, passwords, and internal filesystem paths
 * from log outputs while preserving bounded diagnostic messages.
 */
export function sanitizeLogMessage(input: unknown): string {
  const message =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : String(input ?? '');

  if (!message) {
    return 'Unknown error';
  }

  let sanitized = message;

  // 1. Redact Authorization header values (e.g. Bearer <token>, Basic <token>, or arbitrary auth tokens)
  sanitized = sanitized.replace(
    /(\bauthorization[=:\s]+)(bearer\s+[^\s"',;]+|[^\s"',;]+)/gi,
    '$1[REDACTED]',
  );

  // 2. Redact standalone Bearer tokens
  sanitized = sanitized.replace(
    /\bbearer\s+["']?([^\s"',;]+)["']?/gi,
    'Bearer [REDACTED]',
  );

  // 3. Redact key=value or key: value pairs for secrets, credentials, tokens, passwords, and API keys
  sanitized = sanitized.replace(
    /\b(aws_secret_access_key|aws_secret_key|aws_access_key_id|aws_session_token|secret_key|api_key|auth_token|password|credential|token|secret)\b[=:\s]+["']?([^\s"',;]+)["']?/gi,
    '$1=[REDACTED]',
  );

  // 4. Redact standard AWS Access Key ID patterns (e.g., AKIA..., ASIA...)
  sanitized = sanitized.replace(
    /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    '[REDACTED_AWS_KEY]',
  );

  // 5. Redact 40-character base64-like secret strings
  sanitized = sanitized.replace(/\b[A-Za-z0-9/+=]{40}\b/g, '[REDACTED_SECRET]');

  // 6. Redact internal absolute filesystem paths (Unix and Windows)
  sanitized = sanitized.replace(
    /(?:^|\s)(?:\/(?:var|etc|home|root|tmp|usr|workspaces|app|opt|Users)[^\s:,;'"]*)/g,
    ' [PATH]',
  );
  sanitized = sanitized.replace(
    /(?:^|\s)(?:[a-zA-Z]:\\[^\s:,;'"]*)/g,
    ' [PATH]',
  );

  // Keep diagnostic info bounded (at most 500 characters)
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 497) + '...';
  }

  return sanitized.trim();
}
