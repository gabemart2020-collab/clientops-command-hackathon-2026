import { createHash } from 'node:crypto';
import { CompactSign, type KeyInput } from 'jose';
import { canonicalizeEx } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';
import type { AgentInvocationRequestV1 } from '@clientops/contracts';
import {
  INVOCATION_JWS_HEADER,
  MAX_SIGNED_COMPACT_JWS_CHARS,
  MAX_SIGNED_PAYLOAD_BYTES,
  MAX_SIGNED_REQUEST_BYTES,
  OfflineInvocationSigner,
  SignedInvocationError,
  canonicalInvocationRequest,
  fingerprintInvocationRequest,
  generateEphemeralInvocationKey,
  planInvocationOwnershipIntent,
  parseCanonicalInvocationRequest,
  retryOwnershipMatches,
  verifySignedInvocation as verifySignedInvocationRaw,
  type SignedInvocationVerifierConfig,
} from './signed-invocation.js';

function verifySignedInvocation(
  jws: unknown,
  request: AgentInvocationRequestV1,
  config: SignedInvocationVerifierConfig,
) {
  return verifySignedInvocationRaw(
    jws,
    canonicalInvocationRequest(request),
    config,
  );
}

const callerId = 'clientops-web-staging';
const audience = 'agent-runtime:staging:v1';
const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000011';
const NOW = 1_800_000_000_000;
async function setup() {
  const key = await generateEphemeralInvocationKey('key-current', callerId);
  let index = 1;
  const ownedInvocation: {
    value?: { callerId: string; request: AgentInvocationRequestV1 };
  } = {};
  const signer = new OfflineInvocationSigner(
    key,
    {
      callerId,
      audience,
      certificationIdentity: { organizationId, actorId },
    },
    () => NOW,
    () => `20000000-0000-4000-8000-${String(index++).padStart(12, '0')}`,
    async (requestId) =>
      ownedInvocation.value?.request.requestId === requestId
        ? ownedInvocation.value
        : undefined,
  );
  const config: SignedInvocationVerifierConfig = {
    callerId,
    audience,
    certificationIdentity: { organizationId, actorId },
    keys: { [key.kid]: { callerId, publicKey: key.publicKey } },
    now: () => NOW,
  };
  const signed = await signer.signNew({ userMessage: 'Prepare Acme brief' });
  ownedInvocation.value = { callerId, request: signed.request };
  return { key, signer, config, ...signed };
}

function mutatePayload(
  jws: string,
  mutate: (claims: Record<string, unknown>) => void,
) {
  const [head, payload] = jws.split('.');
  const claims = JSON.parse(
    Buffer.from(payload!, 'base64url').toString(),
  ) as Record<string, unknown>;
  mutate(claims);
  return { head, claims };
}

async function resign(
  jws: string,
  privateKey: KeyInput,
  mutate: (claims: Record<string, unknown>) => void,
) {
  const { head, claims } = mutatePayload(jws, mutate);
  return new CompactSign(new TextEncoder().encode(canonicalizeEx(claims)))
    .setProtectedHeader(JSON.parse(Buffer.from(head!, 'base64url').toString()))
    .sign(privateKey);
}

async function resignRawPayload(
  jws: string,
  privateKey: KeyInput,
  replaceFrom: string,
  replaceTo: string,
) {
  const [head, payload] = jws.split('.');
  const rawPayload = Buffer.from(payload!, 'base64url').toString('utf8');
  const changedPayload = rawPayload.replace(replaceFrom, replaceTo);
  if (changedPayload === rawPayload) throw new Error('Fixture mutation failed');
  const header = JSON.parse(Buffer.from(head!, 'base64url').toString('utf8'));
  return new CompactSign(new TextEncoder().encode(changedPayload))
    .setProtectedHeader(header)
    .sign(privateKey);
}

describe('B1 signed invocation contract (offline cryptographic tests)', () => {
  it('verifies a valid signed envelope and exact V1 request', async () => {
    const test = await setup();
    const claims = await verifySignedInvocation(
      test.jws,
      test.request,
      test.config,
    );
    expect(claims.intent).toBe('NEW');
    expect(claims.payloadFingerprint).toBe(
      fingerprintInvocationRequest(test.request),
    );
    expect(canonicalInvocationRequest(test.request)).toBe(
      '{"actorId":"10000000-0000-4000-8000-000000000011","organizationId":"10000000-0000-4000-8000-000000000001","requestId":"20000000-0000-4000-8000-000000000001","sessionId":"20000000-0000-4000-8000-000000000002","userMessage":"Prepare Acme brief","version":"1"}',
    );
    expect(fingerprintInvocationRequest(test.request)).toBe(
      '155a64af1db1bfb37681972730bf27df6c688cff06ce6309307f289402fbda7d',
    );
  });

  it('uses independent RFC 8785 canonicalization and hash vectors', () => {
    const vector = {
      numbers: [
        JSON.parse('333333333.33333329') as number,
        1e30,
        4.5,
        2e-3,
        1e-27,
      ],
      string: '€$\\u000f\\nA\u0000B',
      literals: [null, true, false],
    };
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\u0000B"}`;
    const canonical = canonicalizeEx(vector);
    expect(canonical).toBe(expected);
    expect(createHash('sha256').update(canonical!).digest('hex')).toBe(
      'abff5625d1fdfcd56b321693a98c1a8653b2e937c54fff73969afe11a4db1602',
    );
  });

  it('binds all request fields and optional-field semantics in the fingerprint', async () => {
    const test = await setup();
    const without = { ...test.request };
    delete (without as Partial<AgentInvocationRequestV1>).accountHint;
    const withValue = { ...without, accountHint: 'Acme Labs' };
    expect(canonicalInvocationRequest(without)).not.toBe(
      canonicalInvocationRequest(withValue),
    );
    expect(fingerprintInvocationRequest(without)).not.toBe(
      fingerprintInvocationRequest(withValue),
    );
    await expect(
      verifySignedInvocation(test.jws, withValue, test.config),
    ).rejects.toThrow();
  });

  it('treats absent and explicitly undefined accountHint as the same wire value', async () => {
    const test = await setup();
    const absent = { ...test.request };
    delete (absent as Partial<AgentInvocationRequestV1>).accountHint;
    const explicitlyUndefined = { ...absent, accountHint: undefined };
    expect(canonicalInvocationRequest(explicitlyUndefined)).toBe(
      canonicalInvocationRequest(absent),
    );
    expect(fingerprintInvocationRequest(explicitlyUndefined)).toBe(
      fingerprintInvocationRequest(absent),
    );
    expect(
      canonicalInvocationRequest({ ...absent, accountHint: 'Acme Labs' }),
    ).not.toBe(canonicalInvocationRequest(absent));
  });

  it.each(['\uD800', '\uDC00'])(
    'rejects unpaired Unicode surrogate %s before signing or verification',
    async (surrogate) => {
      const test = await setup();
      const malformed = { ...test.request, userMessage: `x${surrogate}y` };
      expect(() => canonicalInvocationRequest(malformed)).toThrow(
        'Signed invocation was not authorized.',
      );
      await expect(
        test.signer.signNew({ userMessage: `x${surrogate}y` }),
      ).rejects.toThrow('Signed invocation was not authorized.');
      await expect(
        verifySignedInvocationRaw(
          test.jws,
          JSON.stringify(malformed),
          test.config,
        ),
      ).rejects.toThrow('Signed invocation was not authorized.');
    },
  );

  it('rejects invalid Unicode in configured audience and in verified signed claims', async () => {
    const test = await setup();
    for (const surrogate of ['\uD800', '\uDC00']) {
      const invalidAudienceSigner = new OfflineInvocationSigner(
        test.key,
        {
          callerId,
          audience: `agent-runtime:staging:${surrogate}`,
          certificationIdentity: { organizationId, actorId },
        },
        () => NOW,
      );
      const signingError = await invalidAudienceSigner
        .signNew({ userMessage: 'safe request' })
        .then(
          () => undefined,
          (error: Error) => error,
        );
      const caughtSigningError =
        signingError instanceof Error ? signingError : undefined;
      expect(caughtSigningError).toBeInstanceOf(SignedInvocationError);
      expect(caughtSigningError?.message).toBe(
        'Signed invocation was not authorized.',
      );

      const invalidAudienceJws = await resignRawPayload(
        test.jws,
        test.key.privateKey,
        `"audience":"${audience}"`,
        `"audience":"${surrogate === '\uD800' ? '\\ud800' : '\\udc00'}"`,
      );
      await expect(
        verifySignedInvocation(invalidAudienceJws, test.request, test.config),
      ).rejects.toThrow('Signed invocation was not authorized.');

      const invalidRequestJws = await resignRawPayload(
        test.jws,
        test.key.privateKey,
        '"userMessage":"Prepare Acme brief"',
        `"userMessage":"x${surrogate === '\uD800' ? '\\ud800' : '\\udc00'}y"`,
      );
      await expect(
        verifySignedInvocation(invalidRequestJws, test.request, test.config),
      ).rejects.toThrow('Signed invocation was not authorized.');
    }
  });

  it('signs and verifies valid supplementary Unicode throughout the envelope', async () => {
    const test = await setup();
    const supplementaryAudience = 'agent-runtime:staging:🚀';
    const signer = new OfflineInvocationSigner(
      test.key,
      {
        callerId,
        audience: supplementaryAudience,
        certificationIdentity: { organizationId, actorId },
      },
      () => NOW,
    );
    const signed = await signer.signNew({ userMessage: 'Prepare 🚀 brief' });
    const claims = await verifySignedInvocationRaw(
      signed.jws,
      canonicalInvocationRequest(signed.request),
      { ...test.config, audience: supplementaryAudience },
    );
    expect(claims.audience).toBe(supplementaryAudience);
    expect(claims.request.userMessage).toBe('Prepare 🚀 brief');
  });

  it('rejects programmatic invalid V1 objects with a sanitized invocation error', () => {
    const malformed = {
      version: 'unsupported',
      organizationId,
      actorId,
      requestId: '20000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000002',
      userMessage: 'safe',
    };
    let caught: unknown;
    try {
      canonicalInvocationRequest(malformed as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SignedInvocationError);
    expect((caught as Error).message).toBe(
      'Signed invocation was not authorized.',
    );
    expect((caught as Error).message).not.toContain('unsupported');
  });

  it('accepts approved-format signer key IDs and rejects malformed IDs', async () => {
    const test = await setup();
    const validKeyId = new OfflineInvocationSigner(
      { ...test.key, kid: 'current:key.v1-2026' },
      {
        callerId,
        audience,
        certificationIdentity: { organizationId, actorId },
      },
      () => NOW,
    );
    const signed = await validKeyId.signNew({ userMessage: 'key ID check' });
    await expect(
      verifySignedInvocation(signed.jws, signed.request, {
        ...test.config,
        keys: {
          'current:key.v1-2026': {
            callerId,
            publicKey: test.key.publicKey,
          },
        },
      }),
    ).resolves.toBeDefined();

    for (const kid of ['', 'invalid kid', 'bad/key', 'x'.repeat(129)]) {
      const invalidKeyId = new OfflineInvocationSigner(
        { ...test.key, kid },
        {
          callerId,
          audience,
          certificationIdentity: { organizationId, actorId },
        },
        () => NOW,
      );
      const result = await invalidKeyId
        .signNew({ userMessage: 'key ID check' })
        .catch((error: Error) => error.message);
      expect(result).toBe('Signed invocation was not authorized.');
      expect(typeof result).toBe('string');
    }
  });

  it('rejects invalid non-I-JSON input and preserves independent vectors', () => {
    const testRequest = {
      version: '1',
      organizationId,
      actorId,
      requestId: '20000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000002',
      userMessage: 'valid',
      unexpected: Number.NaN,
    };
    expect(() => canonicalInvocationRequest(testRequest as never)).toThrow();
    expect(() =>
      parseCanonicalInvocationRequest('{"userMessage":NaN}'),
    ).toThrow();
    expect(() =>
      parseCanonicalInvocationRequest('{"userMessage":"x"'),
    ).toThrow();
  });

  it('enforces exact signed wire byte boundaries and round trips accepted requests', async () => {
    const test = await setup();
    const oneCharRequest = { ...test.request, userMessage: 'a' };
    const fixedBytes = Buffer.byteLength(
      canonicalInvocationRequest(oneCharRequest),
      'utf8',
    );
    const accentedCharacters =
      MAX_SIGNED_REQUEST_BYTES - fixedBytes - (8000 - 1);
    expect(accentedCharacters).toBeGreaterThan(0);
    expect(accentedCharacters).toBeLessThan(8000);
    const exactMessage =
      'a'.repeat(8000 - accentedCharacters) + 'é'.repeat(accentedCharacters);
    const exactRequest = { ...test.request, userMessage: exactMessage };
    const exactCanonical = canonicalInvocationRequest(exactRequest);
    expect(Buffer.byteLength(exactCanonical, 'utf8')).toBe(
      MAX_SIGNED_REQUEST_BYTES,
    );
    expect(parseCanonicalInvocationRequest(exactCanonical)).toEqual(
      exactRequest,
    );
    const rejectedMessage = `é${exactMessage.slice(1)}`;
    expect(
      Buffer.byteLength(
        canonicalInvocationRequest({
          ...exactRequest,
          userMessage: rejectedMessage,
        }),
        'utf8',
      ),
    ).toBe(MAX_SIGNED_REQUEST_BYTES + 1);
    expect(() =>
      parseCanonicalInvocationRequest(
        canonicalInvocationRequest({
          ...exactRequest,
          userMessage: rejectedMessage,
        }),
      ),
    ).toThrow('Signed invocation was not authorized.');

    const maxAsciiRequest = {
      ...test.request,
      userMessage: 'a'.repeat(8000),
    };
    const serialized = canonicalInvocationRequest(maxAsciiRequest);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      MAX_SIGNED_REQUEST_BYTES,
    );
    expect(parseCanonicalInvocationRequest(serialized)).toEqual(
      maxAsciiRequest,
    );
    const boundarySigner = new OfflineInvocationSigner(
      test.key,
      {
        callerId,
        audience,
        certificationIdentity: { organizationId, actorId },
      },
      () => NOW,
    );
    const exactBoundary = await boundarySigner.signNew({
      userMessage: exactMessage,
    });
    expect(
      Buffer.byteLength(canonicalInvocationRequest(exactBoundary.request)),
    ).toBe(MAX_SIGNED_REQUEST_BYTES);
    await expect(
      verifySignedInvocation(
        exactBoundary.jws,
        exactBoundary.request,
        test.config,
      ),
    ).resolves.toBeDefined();
    const boundary = await boundarySigner.signNew({
      userMessage: maxAsciiRequest.userMessage,
    });
    expect(boundary.jws.length).toBeLessThanOrEqual(
      MAX_SIGNED_COMPACT_JWS_CHARS,
    );
    expect(
      Buffer.from(boundary.jws.split('.')[1]!, 'base64url').byteLength,
    ).toBeLessThanOrEqual(MAX_SIGNED_PAYLOAD_BYTES);
    await expect(
      verifySignedInvocation(boundary.jws, boundary.request, test.config),
    ).resolves.toBeDefined();
    await expect(
      boundarySigner.signNew({ userMessage: 'a'.repeat(8001) }),
    ).rejects.toThrow('Signed invocation was not authorized.');
    await expect(
      boundarySigner.signNew({ userMessage: rejectedMessage }),
    ).rejects.toThrow('Signed invocation was not authorized.');
  });

  it('rejects oversized multibyte and escaped control content without leaking it', async () => {
    const test = await setup();
    for (const userMessage of ['é'.repeat(8000), '\u0000'.repeat(8000)]) {
      const result = await test.signer
        .signNew({ userMessage })
        .catch((error: Error) => error.message);
      expect(result).toBe('Signed invocation was not authorized.');
      expect(String(result)).not.toContain(userMessage);
    }
    const accepted = await test.signer.signNew({
      userMessage: 'a'.repeat(8000),
    });
    await expect(
      verifySignedInvocation(accepted.jws, accepted.request, test.config),
    ).resolves.toBeDefined();
  });

  it('creates fresh request, session, and replay IDs for every NEW envelope', async () => {
    const test = await setup();
    const second = await test.signer.signNew({
      userMessage: 'Another request',
    });
    expect(second.request.requestId).not.toBe(test.request.requestId);
    expect(second.request.sessionId).not.toBe(test.request.sessionId);
    const firstClaims = await verifySignedInvocation(
      test.jws,
      test.request,
      test.config,
    );
    const secondClaims = await verifySignedInvocation(
      second.jws,
      second.request,
      test.config,
    );
    expect(secondClaims.replayId).not.toBe(firstClaims.replayId);
  });

  it('rejects tampered signature and payload', async () => {
    const test = await setup();
    const parts = test.jws.split('.');
    const signature = parts[2]!;
    const changedSignature = `${signature.slice(0, 20)}${signature[20] === 'A' ? 'B' : 'A'}${signature.slice(21)}`;
    const changedSig = `${parts[0]}.${parts[1]}.${changedSignature}`;
    await expect(
      verifySignedInvocation(changedSig, test.request, test.config),
    ).rejects.toThrow();
    await expect(
      verifySignedInvocation(
        test.jws,
        { ...test.request, userMessage: 'tampered' },
        test.config,
      ),
    ).rejects.toThrow();
  });

  it.each([
    [
      'wrong caller',
      (c: Record<string, unknown>) => {
        c.callerId = 'other-caller';
      },
    ],
    [
      'wrong audience',
      (c: Record<string, unknown>) => {
        c.audience = 'agent-runtime:prod';
      },
    ],
    [
      'wrong organization',
      (c: Record<string, unknown>) => {
        c.organizationId = '10000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'wrong actor',
      (c: Record<string, unknown>) => {
        c.actorId = '10000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'wrong request ID',
      (c: Record<string, unknown>) => {
        c.requestId = '20000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'wrong session ID',
      (c: Record<string, unknown>) => {
        c.sessionId = '20000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'expired',
      (c: Record<string, unknown>) => {
        c.issuedAt = 1_799_999_800;
        c.expiresAt = 1_799_999_920;
      },
    ],
    [
      'future issuedAt',
      (c: Record<string, unknown>) => {
        c.issuedAt = 1_800_000_040;
      },
    ],
    [
      'invalid lifetime',
      (c: Record<string, unknown>) => {
        c.expiresAt = (c.issuedAt as number) + 121;
      },
    ],
    [
      'fingerprint mismatch',
      (c: Record<string, unknown>) => {
        c.payloadFingerprint = '0'.repeat(64);
      },
    ],
    [
      'unsupported claim',
      (c: Record<string, unknown>) => {
        c.issuer = 'unexpected';
      },
    ],
  ])(
    'rejects %s even when signed by an authorized key',
    async (_label, mutation) => {
      const test = await setup();
      const signed = await resign(test.jws, test.key.privateKey, mutation);
      await expect(
        verifySignedInvocation(signed, test.request, test.config),
      ).rejects.toThrow();
    },
  );

  it('rejects alg substitution, missing/extra protected fields, and revoked or unknown keys', async () => {
    const test = await setup();
    const [, payload, signature] = test.jws.split('.');
    const extraHeader = await new CompactSign(new TextEncoder().encode('{}'))
      .setProtectedHeader({
        alg: 'ES256',
        kid: test.key.kid,
        typ: INVOCATION_JWS_HEADER.typ,
        cty: 'application/json',
      })
      .sign(test.key.privateKey);
    await expect(
      verifySignedInvocation(extraHeader, test.request, test.config),
    ).rejects.toThrow();
    const missingType = await new CompactSign(new TextEncoder().encode('{}'))
      .setProtectedHeader({ alg: 'ES256', kid: test.key.kid })
      .sign(test.key.privateKey);
    await expect(
      verifySignedInvocation(missingType, test.request, test.config),
    ).rejects.toThrow();
    const unsignedHeader = Buffer.from(
      JSON.stringify({
        alg: 'none',
        kid: test.key.kid,
        typ: INVOCATION_JWS_HEADER.typ,
      }),
    ).toString('base64url');
    await expect(
      verifySignedInvocation(
        `${unsignedHeader}.${payload}.${signature}`,
        test.request,
        test.config,
      ),
    ).rejects.toThrow();
    const revoked = {
      ...test.config,
      keys: {
        [test.key.kid]: { ...test.config.keys[test.key.kid]!, revoked: true },
      },
    };
    await expect(
      verifySignedInvocation(test.jws, test.request, revoked),
    ).rejects.toThrow();
    await expect(
      verifySignedInvocation(test.jws, test.request, {
        ...test.config,
        keys: {},
      }),
    ).rejects.toThrow();
    await expect(
      verifySignedInvocation(test.jws, test.request, {
        ...test.config,
        now: () => Number.NaN,
      }),
    ).rejects.toThrow();
    const unknownKid = await new CompactSign(new TextEncoder().encode('{}'))
      .setProtectedHeader({
        alg: 'ES256',
        kid: 'unknown',
        typ: INVOCATION_JWS_HEADER.typ,
      })
      .sign(test.key.privateKey);
    await expect(
      verifySignedInvocation(unknownKid, test.request, test.config),
    ).rejects.toThrow();
  });

  it('rejects noncanonical duplicate JSON names before claim use', async () => {
    const test = await setup();
    const [head, , signature] = test.jws.split('.');
    const duplicateBytes = JSON.stringify({
      ...JSON.parse(
        Buffer.from(test.jws.split('.')[1]!, 'base64url').toString(),
      ),
      requestId: test.request.requestId,
    }).replace(
      '"requestId":"' + test.request.requestId + '"',
      '"requestId":"' +
        test.request.requestId +
        '","requestId":"' +
        test.request.requestId +
        '"',
    );
    const duplicateJws = `${head}.${Buffer.from(duplicateBytes).toString('base64url')}.${signature}`;
    await expect(
      verifySignedInvocation(duplicateJws, test.request, test.config),
    ).rejects.toThrow();
    const canonicalRequest = canonicalInvocationRequest(test.request);
    const duplicateRequest = canonicalRequest.replace(
      `"requestId":"${test.request.requestId}"`,
      `"requestId":"${test.request.requestId}","requestId":"${test.request.requestId}"`,
    );
    expect(() => parseCanonicalInvocationRequest(duplicateRequest)).toThrow();
    await expect(
      verifySignedInvocationRaw(test.jws, duplicateRequest, test.config),
    ).rejects.toThrow();
  });

  it('rejects malformed and oversized compact encodings with sanitized errors', async () => {
    const test = await setup();
    for (const bad of ['x.y.z', 'a.b', 'a'.repeat(40_000)]) {
      await expect(
        verifySignedInvocation(bad, test.request, test.config),
      ).rejects.toThrow('Signed invocation was not authorized.');
    }
  });

  it('requires canonical unpadded base64url for every compact JWS segment', async () => {
    const test = await setup();
    await expect(
      verifySignedInvocation(test.jws, test.request, test.config),
    ).resolves.toBeDefined();

    const [header, payload, signature] = test.jws.split('.');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const signatureIndex = alphabet.indexOf(signature!.at(-1)!);
    const aliasLast =
      alphabet[(signatureIndex & ~15) + ((signatureIndex + 1) % 16)]!;
    const aliasedSignature = `${signature!.slice(0, -1)}${aliasLast}`;
    expect(Buffer.from(aliasedSignature, 'base64url')).toEqual(
      Buffer.from(signature!, 'base64url'),
    );

    const malformed = [
      `${header}=.${payload}.${signature}`,
      `${header}.${payload}=.${signature}`,
      `${header}.${payload}.${signature}=`,
      `${header}!.${payload}.${signature}`,
      `${header}.${payload}.${signature!.slice(0, -1)}${aliasLast}`,
      `A.${payload}.${signature}`,
    ];
    for (const token of malformed) {
      await expect(
        verifySignedInvocation(token, test.request, test.config),
      ).rejects.toThrow('Signed invocation was not authorized.');
    }
  });

  it('sanitizes invalid certification identity and generated IDs in signNew', async () => {
    const test = await setup();
    const makeSigner = (
      identity: { organizationId: string; actorId: string },
      ids: () => string,
    ) =>
      new OfflineInvocationSigner(
        test.key,
        { callerId, audience, certificationIdentity: identity },
        () => NOW,
        ids,
      );
    const validIds = () => '20000000-0000-4000-8000-000000000099';
    const invalidCases = [
      makeSigner({ organizationId: 'invalid-org', actorId }, validIds),
      makeSigner({ organizationId, actorId: 'invalid-actor' }, validIds),
      makeSigner({ organizationId, actorId }, () => 'malformed-request-id'),
    ];
    let idIndex = 0;
    invalidCases.push(
      makeSigner({ organizationId, actorId }, () =>
        idIndex++ === 0
          ? '20000000-0000-4000-8000-000000000099'
          : 'malformed-session-id',
      ),
    );
    for (const signer of invalidCases) {
      await expect(
        signer.signNew({ userMessage: 'safe request' }),
      ).rejects.toThrow('Signed invocation was not authorized.');
    }
    await expect(
      test.signer.signNew({ userMessage: 'valid request' }),
    ).resolves.toMatchObject({
      request: expect.any(Object),
      jws: expect.any(String),
    });
    await expect(
      test.signer.signRetry(test.request.requestId, {
        userMessage: test.request.userMessage,
      }),
    ).resolves.toMatchObject({
      request: test.request,
      jws: expect.any(String),
    });
  });

  it('accepts the 30-second future clock-skew boundary and rejects 31 seconds', async () => {
    const test = await setup();
    const valid = { ...test.config, now: () => NOW - 30_000 };
    await expect(
      verifySignedInvocation(test.jws, test.request, valid),
    ).resolves.toBeDefined();
    await expect(
      verifySignedInvocation(test.jws, test.request, {
        ...test.config,
        now: () => NOW - 31_000,
      }),
    ).rejects.toThrow();
  });

  it('binds NEW and RETRY separately and requires matching existing ownership for RETRY', async () => {
    const test = await setup();
    const retry = await test.signer.signRetry(test.request.requestId, {
      userMessage: 'Prepare Acme brief',
    });
    const claims = await verifySignedInvocation(
      retry.jws,
      retry.request,
      test.config,
    );
    expect(claims.intent).toBe('RETRY');
    expect(claims.replayId).not.toBe(
      (await verifySignedInvocation(test.jws, test.request, test.config))
        .replayId,
    );
    const owner = {
      callerId,
      request: test.request,
      payloadFingerprint: fingerprintInvocationRequest(test.request),
    };
    expect(retryOwnershipMatches(claims, owner)).toBe(true);
    expect(retryOwnershipMatches(claims, undefined)).toBe(false);
    expect(retryOwnershipMatches(claims, { ...owner, callerId: 'other' })).toBe(
      false,
    );
    expect(
      retryOwnershipMatches(claims, {
        ...owner,
        payloadFingerprint: '0'.repeat(64),
      }),
    ).toBe(false);
    expect(retryOwnershipMatches({ ...claims, intent: 'NEW' }, owner)).toBe(
      false,
    );
    await expect(
      test.signer.signRetry('30000000-0000-4000-8000-000000000001', {
        userMessage: 'Prepare Acme brief',
      }),
    ).rejects.toThrow();
    await expect(
      test.signer.signRetry(test.request.requestId, {
        userMessage: 'changed payload',
      }),
    ).rejects.toThrow();
  });

  it('plans NEW conditional-create and RETRY find-only without performing ownership writes', async () => {
    const test = await setup();
    const newClaims = await verifySignedInvocation(
      test.jws,
      test.request,
      test.config,
    );
    const retry = await test.signer.signRetry(test.request.requestId, {
      userMessage: 'Prepare Acme brief',
    });
    const retryClaims = await verifySignedInvocation(
      retry.jws,
      retry.request,
      test.config,
    );
    const plans = [
      planInvocationOwnershipIntent(newClaims),
      planInvocationOwnershipIntent(retryClaims),
    ];
    expect(plans).toEqual([
      { operation: 'conditional-create', requestId: test.request.requestId },
      { operation: 'find-only', requestId: test.request.requestId },
    ]);
    const futureStoreWrites: string[] = [];
    const unknownRetry = await test.signer
      .signRetry('30000000-0000-4000-8000-000000000001', {
        userMessage: 'Prepare Acme brief',
      })
      .catch(() => undefined);
    expect(unknownRetry).toBeUndefined();
    expect(futureStoreWrites).toEqual([]);
    expect(plans.every((plan) => !('authorized' in plan))).toBe(true);
  });

  it('rejects browser-supplied authoritative claims in the signer input', async () => {
    const test = await setup();
    await expect(
      test.signer.signNew({
        userMessage: 'hello',
        organizationId,
        actorId,
        requestId: test.request.requestId,
      }),
    ).rejects.toThrow();
  });

  it('accepts a retiring key only while explicitly present in the trusted overlap set', async () => {
    const test = await setup();
    const retiring = await generateEphemeralInvocationKey(
      'key-retiring',
      callerId,
    );
    const retiringSigner = new OfflineInvocationSigner(
      retiring,
      {
        callerId,
        audience,
        certificationIdentity: { organizationId, actorId },
      },
      () => NOW,
    );
    const token = await retiringSigner.signNew({ userMessage: 'rotated key' });
    await expect(
      verifySignedInvocation(token.jws, token.request, test.config),
    ).rejects.toThrow();
    await expect(
      verifySignedInvocation(token.jws, token.request, {
        ...test.config,
        keys: {
          ...test.config.keys,
          [retiring.kid]: { callerId, publicKey: retiring.publicKey },
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      verifySignedInvocation(token.jws, token.request, {
        ...test.config,
        keys: {
          ...test.config.keys,
          [retiring.kid]: { callerId, publicKey: retiring.publicKey },
          'key-extra': { callerId, publicKey: test.key.publicKey },
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects invalid key material and does not expose raw payloads or keys', async () => {
    const test = await setup();
    const invalid = {
      ...test.config,
      keys: {
        [test.key.kid]: { callerId, publicKey: 'private raw secret' as never },
      },
    };
    const result = await verifySignedInvocation(
      test.jws,
      test.request,
      invalid,
    ).catch((error: Error) => error.message);
    expect(result).toBe('Signed invocation was not authorized.');
    expect(String(result)).not.toContain('Prepare Acme brief');
    expect(String(result)).not.toContain('private raw secret');
    const privateKeyConfig = {
      ...test.config,
      keys: { [test.key.kid]: { callerId, publicKey: test.key.privateKey } },
    };
    await expect(
      verifySignedInvocation(test.jws, test.request, privateKeyConfig),
    ).rejects.toThrow();
    const mismatchedCallerConfig = {
      ...test.config,
      keys: {
        [test.key.kid]: {
          callerId: 'other-caller',
          publicKey: test.key.publicKey,
        },
      },
    };
    await expect(
      verifySignedInvocation(test.jws, test.request, mismatchedCallerConfig),
    ).rejects.toThrow();
  });
});
