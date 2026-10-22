import { createHash, randomUUID } from 'node:crypto';
import {
  AgentInvocationRequestV1Schema,
  AgentRuntimeCertificationIdentitySchema,
  type AgentInvocationRequestV1,
} from '@clientops/contracts';
import { z } from 'zod';

/**
 * Offline policy primitive for a future authenticated staging certification caller.
 * It does not authenticate AWS requests and is not a remote ingress boundary.
 * Gate B must supply the trusted principal from verified AWS identity, and
 * supply a durable/atomic ownership store before remote invocation is enabled.
 */
const TrustedCallerPrincipalSchema = z
  .string()
  .regex(new RegExp('^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$'));

const InputSchema = z
  .object({
    userMessage: z.string().trim().min(1).max(8000),
    accountHint: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const ReplayKeySchema = z.string().uuid();

export type TrustedCallerInput = z.infer<typeof InputSchema>;

export interface TrustedCallerConfiguration {
  principalArn: string;
  certificationIdentity: {
    organizationId: string;
    actorId: string;
  };
}

export interface TrustedCallerContext {
  /** Must be derived from an authenticated channel, never the user payload. */
  verifiedPrincipalArn: string;
}

export interface CallerOwnedRequest {
  principalArn: string;
  request: AgentInvocationRequestV1;
  fingerprint: string;
}

export interface CallerRequestOwnershipStore {
  /** Read an existing immutable record without claiming an unknown request ID. */
  find(requestId: string): Promise<CallerOwnedRequest | undefined>;
  /**
   * Atomically insert if absent, otherwise return the existing immutable record.
   * An in-memory map is only suitable for offline tests; use durable storage for
   * remote invocation, retry across processes, and crash recovery.
   */
  getOrCreate(record: CallerOwnedRequest): Promise<CallerOwnedRequest>;
}

export class TrustedCallerPolicyError extends Error {
  constructor() {
    super('Trusted caller request was not authorized.');
    this.name = 'TrustedCallerPolicyError';
  }
}

function canonicalFingerprint(
  principalArn: string,
  request: AgentInvocationRequestV1,
): string {
  // Explicit canonical field selection excludes property insertion order.
  return createHash('sha256')
    .update(
      JSON.stringify([
        principalArn,
        request.version,
        request.requestId,
        request.sessionId,
        request.organizationId,
        request.actorId,
        request.userMessage,
        request.accountHint ?? null,
      ]),
    )
    .digest('hex');
}

function validPrincipal(value: string): string {
  const parsed = TrustedCallerPrincipalSchema.safeParse(value);
  if (!parsed.success) throw new TrustedCallerPolicyError();
  return parsed.data;
}

export class TrustedStagingCallerPolicy {
  private readonly configuredPrincipal: string;
  private readonly organizationId: string;
  private readonly actorId: string;

  constructor(
    config: TrustedCallerConfiguration,
    private readonly store: CallerRequestOwnershipStore,
  ) {
    this.configuredPrincipal = validPrincipal(config.principalArn);
    const identity = AgentRuntimeCertificationIdentitySchema.parse(
      config.certificationIdentity,
    );
    this.organizationId = identity.organizationId;
    this.actorId = identity.actorId;
  }

  async prepare(
    context: TrustedCallerContext,
    untrustedInput: unknown,
    retryRequestId?: string,
  ): Promise<AgentInvocationRequestV1> {
    // Do not accept principal or identity claims from the payload.
    if (!context || typeof context.verifiedPrincipalArn !== 'string') {
      throw new TrustedCallerPolicyError();
    }
    const principal = validPrincipal(context.verifiedPrincipalArn);
    if (principal !== this.configuredPrincipal) {
      throw new TrustedCallerPolicyError();
    }
    const input = InputSchema.safeParse(untrustedInput);
    if (!input.success) throw new TrustedCallerPolicyError();
    if (
      retryRequestId !== undefined &&
      !ReplayKeySchema.safeParse(retryRequestId).success
    ) {
      throw new TrustedCallerPolicyError();
    }

    const requestId = retryRequestId ?? randomUUID();
    const request = AgentInvocationRequestV1Schema.parse({
      version: '1',
      requestId,
      sessionId: randomUUID(),
      organizationId: this.organizationId,
      actorId: this.actorId,
      ...input.data,
    });

    // Retry ownership must be resolved BEFORE generating another session ID.
    // With an existing request, fingerprint the original stable session and
    // reject changed payloads, rather than trusting any supplied session.
    const existing =
      retryRequestId === undefined
        ? await this.store.getOrCreate({
            principalArn: principal,
            request,
            fingerprint: canonicalFingerprint(principal, request),
          })
        : await this.store.find(retryRequestId);
    if (!existing) throw new TrustedCallerPolicyError();
    if (
      existing.principalArn !== principal ||
      existing.request.requestId !== requestId ||
      existing.request.organizationId !== this.organizationId ||
      existing.request.actorId !== this.actorId
    ) {
      throw new TrustedCallerPolicyError();
    }
    const resolved = AgentInvocationRequestV1Schema.safeParse(existing.request);
    if (!resolved.success) throw new TrustedCallerPolicyError();
    if (
      resolved.data.userMessage !== input.data.userMessage ||
      (resolved.data.accountHint ?? null) !==
        (input.data.accountHint ?? null) ||
      existing.fingerprint !== canonicalFingerprint(principal, resolved.data)
    ) {
      throw new TrustedCallerPolicyError();
    }
    return resolved.data;
  }
}

/** Test-only, not an implementation of a distributed durable store. */
export class InMemoryCallerOwnershipStore implements CallerRequestOwnershipStore {
  private readonly records = new Map<string, CallerOwnedRequest>();

  async find(requestId: string): Promise<CallerOwnedRequest | undefined> {
    const record = this.records.get(requestId);
    return record ? structuredClone(record) : undefined;
  }

  async getOrCreate(record: CallerOwnedRequest): Promise<CallerOwnedRequest> {
    const existing = this.records.get(record.request.requestId);
    if (existing) return structuredClone(existing);
    this.records.set(record.request.requestId, structuredClone(record));
    return structuredClone(record);
  }
}
