import { createHash, randomUUID } from 'node:crypto';
import {
  CompactSign,
  compactVerify,
  generateKeyPair,
  type KeyInput,
} from 'jose';
import { canonicalizeEx } from 'json-canonicalize';
import {
  AgentInvocationRequestV1Schema,
  SignedInvocationEnvelopeV1Schema,
  type AgentInvocationRequestV1,
  type SignedInvocationEnvelopeV1,
} from '@clientops/contracts';
import { z } from 'zod';

export const INVOCATION_JWS_HEADER = {
  typ: 'clientops-invocation+jws',
  alg: 'ES256',
} as const;
export const INVOCATION_MAX_LIFETIME_SECONDS = 120;
export const INVOCATION_MAX_CLOCK_SKEW_SECONDS = 30;
/** B1 wire limits are narrower than the V1 schema's character limits. */
export const MAX_SIGNED_REQUEST_BYTES = 16_000;
export const MAX_SIGNED_PAYLOAD_BYTES = 18_432;
export const MAX_SIGNED_COMPACT_JWS_CHARS = 32_768;
const MAX_SEGMENT_CHARS = 24_576;
const MAX_VERIFICATION_KEYS = 2;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const InputSchema = z
  .object({
    userMessage: z.string().trim().min(1).max(8000),
    accountHint: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export class SignedInvocationError extends Error {
  constructor() {
    super('Signed invocation was not authorized.');
    this.name = 'SignedInvocationError';
  }
}

function fail(): never {
  throw new SignedInvocationError();
}

export function canonicalInvocationRequest(
  request: AgentInvocationRequestV1,
): string {
  try {
    const parsed = AgentInvocationRequestV1Schema.parse(request);
    rejectUnpairedSurrogates(parsed);
    // `undefined` is not a JSON value. For the optional V1 field, its absence
    // and an explicitly undefined TypeScript property have the same wire form.
    const normalized = {
      version: parsed.version,
      organizationId: parsed.organizationId,
      actorId: parsed.actorId,
      requestId: parsed.requestId,
      sessionId: parsed.sessionId,
      userMessage: parsed.userMessage,
      ...(parsed.accountHint === undefined
        ? {}
        : { accountHint: parsed.accountHint }),
    };
    const result = canonicalizeEx(normalized, {
      undefinedInArrayToNull: false,
    });
    if (typeof result !== 'string') return fail();
    return result;
  } catch {
    return fail();
  }
}

function rejectUnpairedSurrogates(value: unknown): void {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error();
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error();
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(rejectUnpairedSurrogates);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      rejectUnpairedSurrogates(key);
      rejectUnpairedSurrogates(child);
    }
  }
}

export function fingerprintInvocationRequest(
  request: AgentInvocationRequestV1,
): string {
  return createHash('sha256')
    .update(canonicalInvocationRequest(request), 'utf8')
    .digest('hex');
}

/** Parse the canonical wire representation so duplicate JSON names cannot be hidden by JSON.parse. */
export function parseCanonicalInvocationRequest(
  serialized: unknown,
): AgentInvocationRequestV1 {
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_SIGNED_REQUEST_BYTES
  )
    return fail();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return fail();
  }
  const request = AgentInvocationRequestV1Schema.safeParse(value);
  if (
    !request.success ||
    canonicalInvocationRequest(request.data) !== serialized
  )
    return fail();
  return request.data;
}

export interface OfflineSigningKey {
  kid: string;
  callerId: string;
  privateKey: KeyInput;
}

export interface TrustedCallerPolicy {
  callerId: string;
  audience: string;
  certificationIdentity: { organizationId: string; actorId: string };
}

export interface TrustedOwnedInvocation {
  callerId: string;
  request: AgentInvocationRequestV1;
}

export type OwnedInvocationLookup = (
  requestId: string,
) => Promise<TrustedOwnedInvocation | undefined>;

export interface VerificationKey {
  callerId: string;
  publicKey: KeyInput;
  revoked?: boolean;
}

export interface SignedInvocationVerifierConfig {
  audience: string;
  callerId: string;
  certificationIdentity: { organizationId: string; actorId: string };
  keys: Readonly<Record<string, VerificationKey>>;
  now?: () => number;
}

/** Generates an ephemeral local key. Never persist or commit its private half. */
export async function generateEphemeralInvocationKey(
  kid: string,
  callerId: string,
) {
  if (!KEY_ID_PATTERN.test(kid) || !callerId) return fail();
  const pair = await generateKeyPair('ES256', { extractable: true });
  return { kid, callerId, ...pair };
}

export class OfflineInvocationSigner {
  constructor(
    private readonly key: OfflineSigningKey,
    private readonly policy: TrustedCallerPolicy,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    private readonly findOwned?: OwnedInvocationLookup,
  ) {}

  async signNew(
    input: unknown,
  ): Promise<{ request: AgentInvocationRequestV1; jws: string }> {
    const body = InputSchema.safeParse(input);
    if (!body.success) return fail();
    let request: AgentInvocationRequestV1;
    try {
      request = AgentInvocationRequestV1Schema.parse({
        version: '1',
        organizationId: this.policy.certificationIdentity.organizationId,
        actorId: this.policy.certificationIdentity.actorId,
        requestId: this.newId(),
        sessionId: this.newId(),
        ...body.data,
      });
      rejectUnpairedSurrogates(request);
    } catch {
      return fail();
    }
    return { request, jws: await this.signRequest(request, 'NEW') };
  }

  async signRetry(
    requestId: string,
    input: unknown,
  ): Promise<{ request: AgentInvocationRequestV1; jws: string }> {
    const body = InputSchema.safeParse(input);
    if (
      !body.success ||
      !this.findOwned ||
      !z.string().uuid().safeParse(requestId).success
    )
      return fail();
    let ownership: TrustedOwnedInvocation | undefined;
    try {
      ownership = await this.findOwned(requestId);
    } catch {
      return fail();
    }
    const request = AgentInvocationRequestV1Schema.safeParse(
      ownership?.request,
    );
    if (
      !ownership ||
      ownership.callerId !== this.policy.callerId ||
      !request.success ||
      request.data.requestId !== requestId
    )
      return fail();
    const identity = this.policy.certificationIdentity;
    if (
      request.data.organizationId !== identity.organizationId ||
      request.data.actorId !== identity.actorId ||
      request.data.userMessage !== body.data.userMessage ||
      (request.data.accountHint ?? null) !== (body.data.accountHint ?? null)
    )
      return fail();
    return {
      request: request.data,
      jws: await this.signRequest(request.data, 'RETRY'),
    };
  }

  private async signRequest(
    request: AgentInvocationRequestV1,
    intent: 'NEW' | 'RETRY',
  ) {
    try {
      if (
        !KEY_ID_PATTERN.test(this.key.kid) ||
        this.key.callerId !== this.policy.callerId
      )
        return fail();
      const canonicalRequest = canonicalInvocationRequest(request);
      if (
        Buffer.byteLength(canonicalRequest, 'utf8') > MAX_SIGNED_REQUEST_BYTES
      )
        return fail();
      const issuedAt = Math.floor(this.now() / 1000);
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return fail();
      const claims = SignedInvocationEnvelopeV1Schema.parse({
        envelopeVersion: '1',
        callerId: this.policy.callerId,
        audience: this.policy.audience,
        intent,
        organizationId: request.organizationId,
        actorId: request.actorId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        payloadFingerprint: fingerprintInvocationRequest(request),
        issuedAt,
        expiresAt: issuedAt + INVOCATION_MAX_LIFETIME_SECONDS,
        replayId: this.newId(),
        request,
      });
      rejectUnpairedSurrogates(claims);
      const payload = new TextEncoder().encode(
        canonicalizeEx(claims, { undefinedInArrayToNull: false }),
      );
      if (payload.byteLength > MAX_SIGNED_PAYLOAD_BYTES) return fail();
      const jws = await new CompactSign(payload)
        .setProtectedHeader({
          alg: 'ES256',
          kid: this.key.kid,
          typ: INVOCATION_JWS_HEADER.typ,
        })
        .sign(this.key.privateKey);
      validateCompactJwsBounds(jws);
      return jws;
    } catch {
      return fail();
    }
  }
}

function validateCompactJwsBounds(jws: string): void {
  if (jws.length > MAX_SIGNED_COMPACT_JWS_CHARS) return fail();
  const pieces = jws.split('.');
  if (
    pieces.length !== 3 ||
    pieces.some((part) => !part || part.length > MAX_SEGMENT_CHARS) ||
    Buffer.from(pieces[1]!, 'base64url').byteLength > MAX_SIGNED_PAYLOAD_BYTES
  )
    return fail();
}

function decodeCanonicalSegment(segment: string): {
  bytes: Uint8Array;
  value: unknown;
} {
  const bytes = decodeCanonicalBase64url(segment);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
  const canonical = canonicalizeEx(value, { undefinedInArrayToNull: false });
  if (
    typeof canonical !== 'string' ||
    canonical !== Buffer.from(bytes).toString('utf8')
  )
    return fail();
  return { bytes, value };
}

function decodeCanonicalBase64url(segment: string): Buffer {
  if (
    !segment ||
    segment.length > MAX_SEGMENT_CHARS ||
    segment.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(segment)
  )
    return fail();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) return fail();
  return bytes;
}

function isPublicEs256Key(value: KeyInput): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    value instanceof Uint8Array
  )
    return false;
  const material = value as unknown as Record<string, unknown>;
  if (material.kty === 'EC') {
    return (
      material.crv === 'P-256' &&
      typeof material.x === 'string' &&
      typeof material.y === 'string' &&
      !('d' in material) &&
      !('k' in material)
    );
  }
  if (material.type !== 'public') return false;
  if (material.asymmetricKeyType === 'ec') {
    const details = material.asymmetricKeyDetails as
      | Record<string, unknown>
      | undefined;
    return (
      details?.namedCurve === 'prime256v1' || details?.namedCurve === 'P-256'
    );
  }
  const algorithm = material.algorithm as Record<string, unknown> | undefined;
  const usages = material.usages;
  return (
    algorithm?.name === 'ECDSA' &&
    algorithm.namedCurve === 'P-256' &&
    Array.isArray(usages) &&
    usages.includes('verify')
  );
}

export async function verifySignedInvocation(
  jws: unknown,
  requestInput: unknown,
  config: SignedInvocationVerifierConfig,
): Promise<SignedInvocationEnvelopeV1> {
  try {
    if (typeof jws !== 'string' || jws.length > MAX_SIGNED_COMPACT_JWS_CHARS)
      return fail();
    if (
      !config?.keys ||
      Object.keys(config.keys).length < 1 ||
      Object.keys(config.keys).length > MAX_VERIFICATION_KEYS
    )
      return fail();
    const pieces = jws.split('.');
    if (
      pieces.length !== 3 ||
      pieces.some((part) => !part || part.length > MAX_SEGMENT_CHARS)
    )
      return fail();
    // Canonical, unpadded base64url is part of the compact JWS wire contract.
    // Validate every segment before JOSE sees the token (including signature
    // pad bits, which some JOSE versions accept in alternate encodings).
    pieces.forEach(decodeCanonicalBase64url);
    const header = decodeCanonicalSegment(pieces[0]!).value as Record<
      string,
      unknown
    >;
    const allowedHeader = ['alg', 'kid', 'typ'];
    if (
      Object.keys(header).sort().join(',') !== allowedHeader.join(',') ||
      header.alg !== 'ES256' ||
      header.typ !== INVOCATION_JWS_HEADER.typ ||
      typeof header.kid !== 'string' ||
      !KEY_ID_PATTERN.test(header.kid)
    )
      return fail();
    const key = config.keys[header.kid];
    if (
      !key ||
      key.revoked ||
      key.callerId !== config.callerId ||
      !isPublicEs256Key(key.publicKey)
    )
      return fail();

    const verified = await compactVerify(jws, key.publicKey, {
      algorithms: ['ES256'],
    });
    if (verified.payload.byteLength > MAX_SIGNED_PAYLOAD_BYTES) return fail();
    const rawPayload = new TextDecoder('utf-8', { fatal: true }).decode(
      verified.payload,
    );
    const parsedClaims: unknown = JSON.parse(rawPayload);
    rejectUnpairedSurrogates(parsedClaims);
    if (
      canonicalizeEx(parsedClaims, { undefinedInArrayToNull: false }) !==
      rawPayload
    )
      return fail();
    const claims = SignedInvocationEnvelopeV1Schema.parse(parsedClaims);
    const request = parseCanonicalInvocationRequest(requestInput);
    const now = Math.floor((config.now ?? Date.now)() / 1000);
    if (!Number.isSafeInteger(now) || now < 0) return fail();
    if (
      claims.callerId !== config.callerId ||
      claims.audience !== config.audience ||
      claims.organizationId !== config.certificationIdentity.organizationId ||
      claims.actorId !== config.certificationIdentity.actorId ||
      claims.requestId !== request.requestId ||
      claims.sessionId !== request.sessionId ||
      claims.organizationId !== request.organizationId ||
      claims.actorId !== request.actorId ||
      claims.payloadFingerprint !== fingerprintInvocationRequest(request) ||
      fingerprintInvocationRequest(claims.request) !==
        claims.payloadFingerprint ||
      canonicalInvocationRequest(claims.request) !==
        canonicalInvocationRequest(request) ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > INVOCATION_MAX_LIFETIME_SECONDS ||
      claims.issuedAt > now + INVOCATION_MAX_CLOCK_SKEW_SECONDS ||
      now > claims.expiresAt + INVOCATION_MAX_CLOCK_SKEW_SECONDS
    )
      return fail();
    return claims;
  } catch {
    return fail();
  }
}

/**
 * Future B2 adapter contract only. It must receive verifier-approved claims,
 * atomically consume replayId, and enforce conditional NEW / find-only RETRY.
 * B1 deliberately exposes no mutation or execution authorization function.
 */
export interface InvocationOwnershipStoreContract {
  /** Atomically rejects reused request/replay IDs and creates first ownership. */
  claimNewIfAbsentAndConsumeReplay(record: {
    callerId: string;
    request: AgentInvocationRequestV1;
    payloadFingerprint: string;
    replayId: string;
  }): Promise<'created' | 'conflict'>;
  /** Lookup only; an unknown request never creates ownership or replay state. */
  find(requestId: string): Promise<
    | {
        callerId: string;
        request: AgentInvocationRequestV1;
        payloadFingerprint: string;
      }
    | undefined
  >;
  /** Atomically matches immutable ownership and consumes a fresh RETRY replay ID. */
  verifyOwnerAndConsumeRetryReplay(input: {
    callerId: string;
    request: AgentInvocationRequestV1;
    payloadFingerprint: string;
    replayId: string;
  }): Promise<boolean>;
}

/**
 * Advisory routing plan only. Callers must not treat this as ownership,
 * replay, or execution authorization. B2 must verify the signature and make
 * the ownership/replay decision atomically before any agent execution.
 */
export function planInvocationOwnershipIntent(
  claims: Pick<SignedInvocationEnvelopeV1, 'intent' | 'requestId'>,
):
  | { operation: 'conditional-create'; requestId: string }
  | { operation: 'find-only'; requestId: string } {
  return claims.intent === 'NEW'
    ? { operation: 'conditional-create', requestId: claims.requestId }
    : { operation: 'find-only', requestId: claims.requestId };
}

/** Pure immutable-field comparison; this is not an execution authorization. */
export function retryOwnershipMatches(
  claims: SignedInvocationEnvelopeV1,
  owner:
    | {
        callerId: string;
        request: AgentInvocationRequestV1;
        payloadFingerprint: string;
      }
    | undefined,
): boolean {
  try {
    return Boolean(
      claims.intent === 'RETRY' &&
      owner &&
      owner.callerId === claims.callerId &&
      owner.request.requestId === claims.requestId &&
      owner.request.sessionId === claims.sessionId &&
      owner.request.organizationId === claims.organizationId &&
      owner.request.actorId === claims.actorId &&
      owner.payloadFingerprint === claims.payloadFingerprint &&
      fingerprintInvocationRequest(owner.request) ===
        owner.payloadFingerprint &&
      canonicalInvocationRequest(owner.request) ===
        canonicalInvocationRequest(claims.request),
    );
  } catch {
    return false;
  }
}
