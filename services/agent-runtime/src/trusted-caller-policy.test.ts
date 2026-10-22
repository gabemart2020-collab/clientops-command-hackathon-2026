import { describe, expect, it } from 'vitest';
import {
  InMemoryCallerOwnershipStore,
  TrustedCallerPolicyError,
  TrustedStagingCallerPolicy,
} from './trusted-caller-policy.js';

const principal =
  'arn:aws:iam::111122223333:role/clientops-staging-certification-caller';
const otherPrincipal = 'arn:aws:iam::111122223333:role/unapproved';
const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000011';
const payload = {
  userMessage: 'Prepare the Acme review brief.',
  accountHint: 'Acme Labs',
};

function setup() {
  const store = new InMemoryCallerOwnershipStore();
  const policy = new TrustedStagingCallerPolicy(
    {
      principalArn: principal,
      certificationIdentity: { organizationId, actorId },
    },
    store,
  );
  return { policy, store };
}

describe('Phase 5.2.3-A trusted staging caller contract (offline only)', () => {
  it('constructs all authority and ID fields server-side', async () => {
    const { policy } = setup();
    const request = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
    );
    expect(request).toMatchObject({
      version: '1',
      organizationId,
      actorId,
      userMessage: payload.userMessage,
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request).not.toHaveProperty('principalArn');
  });

  it.each([
    'organizationId',
    'actorId',
    'requestId',
    'sessionId',
    'role',
    'approvalState',
  ])('rejects untrusted control field %s', async (field) => {
    const { policy } = setup();
    await expect(
      policy.prepare(
        { verifiedPrincipalArn: principal },
        { ...payload, [field]: actorId },
      ),
    ).rejects.toBeInstanceOf(TrustedCallerPolicyError);
  });

  it('rejects an unverified, malformed, or unapproved identity', async () => {
    const { policy } = setup();
    await expect(
      policy.prepare({ verifiedPrincipalArn: otherPrincipal }, payload),
    ).rejects.toThrow(TrustedCallerPolicyError);
    await expect(
      policy.prepare({ verifiedPrincipalArn: 'browser' }, payload),
    ).rejects.toThrow(TrustedCallerPolicyError);
    await expect(policy.prepare({} as never, payload)).rejects.toThrow(
      TrustedCallerPolicyError,
    );
  });

  it('preserves request and session IDs on same-caller identical retry', async () => {
    const { policy } = setup();
    const first = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
    );
    const retry = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
      first.requestId,
    );
    expect(retry).toEqual(first);
  });

  it('does not claim an unknown valid retry ID', async () => {
    const { policy, store } = setup();
    const unknownRequestId = '33333333-3333-4333-8333-333333333333';

    await expect(
      policy.prepare(
        { verifiedPrincipalArn: principal },
        payload,
        unknownRequestId,
      ),
    ).rejects.toThrow(TrustedCallerPolicyError);

    expect(await store.find(unknownRequestId)).toBeUndefined();
  });

  it('keeps ownership records immutable through defensive copies', async () => {
    const { policy, store } = setup();
    const request = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
    );

    request.userMessage = 'mutated returned request';
    const stored = await store.find(request.requestId);
    expect(stored?.request.userMessage).toBe(payload.userMessage);

    if (!stored) throw new Error('Expected caller ownership record.');
    stored.request.userMessage = 'mutated fetched record';
    const duplicate = await store.getOrCreate(stored);
    duplicate.request.userMessage = 'mutated duplicate response';
    const fetchedAgain = await store.find(request.requestId);
    expect(fetchedAgain?.request.userMessage).toBe(payload.userMessage);
  });

  it('rejects changed content for an already-owned request ID', async () => {
    const { policy } = setup();
    const first = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
    );
    await expect(
      policy.prepare(
        { verifiedPrincipalArn: principal },
        { ...payload, userMessage: 'Do something different' },
        first.requestId,
      ),
    ).rejects.toThrow(TrustedCallerPolicyError);
  });

  it('does not allow another principal to replay an owned request', async () => {
    const { policy } = setup();
    const first = await policy.prepare(
      { verifiedPrincipalArn: principal },
      payload,
    );
    await expect(
      policy.prepare(
        { verifiedPrincipalArn: otherPrincipal },
        payload,
        first.requestId,
      ),
    ).rejects.toThrow(TrustedCallerPolicyError);
  });

  it('rejects unknown or malformed retry request IDs', async () => {
    const { policy } = setup();
    await expect(
      policy.prepare(
        { verifiedPrincipalArn: principal },
        payload,
        'not-a-uuid',
      ),
    ).rejects.toThrow(TrustedCallerPolicyError);
  });

  it('rejects corrupted ownership records without exposing values', async () => {
    const store = {
      find: async () => undefined,
      getOrCreate: async () => ({
        principalArn: otherPrincipal,
        fingerprint: 'incorrect',
        request: {
          version: '1' as const,
          requestId: '11111111-1111-4111-8111-111111111111',
          sessionId: '22222222-2222-4222-8222-222222222222',
          organizationId,
          actorId,
          userMessage: payload.userMessage,
        },
      }),
    };
    const policy = new TrustedStagingCallerPolicy(
      {
        principalArn: principal,
        certificationIdentity: { organizationId, actorId },
      },
      store,
    );
    await expect(
      policy.prepare({ verifiedPrincipalArn: principal }, payload),
    ).rejects.toThrow(TrustedCallerPolicyError);
  });
});
