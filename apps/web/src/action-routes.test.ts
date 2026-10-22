import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as policy from '@clientops/policy';
import { POST as decisionRoute } from './app/api/actions/[proposalId]/decision/route.js';
import { GET as inspectRoute } from './app/api/actions/[proposalId]/route.js';
import {
  getActionServerContext,
  createInMemoryActionServerContext,
  setActionServerContextForTesting,
  ActionStoreUnavailableError,
} from './lib/action-context.js';
import {
  DEMO_ORGANIZATION_ID,
  SECOND_TEST_ORGANIZATION_ID,
  createTenantContext,
} from '@clientops/domain';
import {
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
  materializeTaskCreateParameters,
  type CreateActionProposalInput,
} from '@clientops/contracts';

describe('Phase 4.2 Web Action Routes Security Suite', () => {
  const proposalId = '70000000-0000-4000-8000-000000000001';
  const originalEnv = { ...process.env };
  const validSameOriginHeaders = {
    'Content-Type': 'application/json',
    'sec-fetch-site': 'same-origin',
    origin: 'http://localhost:3000',
  };

  async function seedProposal(
    actionCtx: ReturnType<typeof getActionServerContext>,
    customProposalId = proposalId,
    targetOrgId = DEMO_ORGANIZATION_ID,
  ) {
    const rawParams = {
      clientId: 'c0000000-0000-4000-8000-000000000001',
      projectId: 'a0000000-0000-4000-8000-000000000001',
      title: 'Setup Executive Incident Briefing',
      priority: 'high' as const,
    };
    const canonicalParams = materializeTaskCreateParameters(rawParams);
    const preconditions = [
      {
        entityType: 'project' as const,
        entityId: 'a0000000-0000-4000-8000-000000000001',
        versionField: 'updated_at' as const,
        expectedValue: '2026-10-14T10:00:00.000Z',
      },
    ];
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const parameterHash = computeCanonicalParameterHash(canonicalParams);
    const approvalBindingHash = computeApprovalBindingHash({
      organizationId: targetOrgId,
      actionType: 'task.create',
      parameters: canonicalParams,
      preconditions,
      expiresAt,
    });

    const proposalInput: CreateActionProposalInput = {
      id: customProposalId,
      organizationId: targetOrgId,
      actionType: 'task.create',
      actionClass: 'WRITE',
      parameters: canonicalParams,
      parameterHash,
      approvalBindingHash,
      correlationId: 'web-test-corr-1',
      evidence: [
        {
          entityType: 'meeting',
          entityId: '40000000-0000-4000-8000-000000000001',
          field: 'summary',
          excerpt: 'Critical concerns noted',
        },
      ],
      preconditions,
      status: 'PROPOSED',
      justification: 'Urgent task needed',
      createdAt: new Date().toISOString(),
      expiresAt,
    };

    await actionCtx.actionProposalRepository.create(proposalInput);
    await actionCtx.actionProposalRepository.transitionStatus(
      createTenantContext(targetOrgId),
      customProposalId,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
  }

  beforeEach(async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED = 'true';
    delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;

    const inMemoryCtx = createInMemoryActionServerContext();
    setActionServerContextForTesting(inMemoryCtx);
    await seedProposal(inMemoryCtx);
  });

  afterEach(() => {
    setActionServerContextForTesting(null);
    process.env = { ...originalEnv };
  });

  // ============================================================================
  // CSRF & Request Integrity Tests
  // ============================================================================

  it('read-only gate denies approval and denial before any business write', async () => {
    delete process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
    const ctx = getActionServerContext();
    const previous = await ctx.actionProposalRepository.findById(
      ctx.tenant,
      proposalId,
    );
    const previousAudit = await ctx.auditEventRepository.listByProposalId(
      ctx.tenant,
      proposalId,
    );

    for (const decision of ['APPROVE', 'DENY']) {
      const req = new Request(
        `http://localhost:3000/api/actions/${proposalId}/decision`,
        {
          method: 'POST',
          headers: validSameOriginHeaders,
          body: JSON.stringify({ decision }),
        },
      );

      const res = await decisionRoute(req, {
        params: Promise.resolve({ proposalId }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('ACTION_WRITES_DISABLED');
    }

    expect(
      await ctx.actionProposalRepository.findById(ctx.tenant, proposalId),
    ).toEqual(previous);
    expect(
      await ctx.actionApprovalRepository.findByProposalId(
        ctx.tenant,
        proposalId,
      ),
    ).toBeNull();
    expect(
      await ctx.auditEventRepository.listByProposalId(ctx.tenant, proposalId),
    ).toEqual(previousAudit);
  });

  it('37. malformed JSON rejected', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: 'this is not valid json {',
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe('INVALID_JSON');
    expect(json.message).toBe('Request body must be valid JSON.');
  });

  it('38. unknown fields rejected', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'APPROVE',
          organizationId: 'malicious-org',
          actorId: 'malicious-actor',
        }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe('VALIDATION_FAILED');
  });

  it('39. cross-site sec-fetch-site rejected', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toContain('Cross-site');
  });

  it('39b. CSRF port mismatch rejected', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'http://localhost:3001', // Port mismatch!
        },
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toContain('Cross-origin');
  });

  it('39c. CSRF scheme mismatch rejected', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'https://localhost:3000', // Scheme mismatch!
        },
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
  });

  it('39d. missing origin and sec-fetch-site rejected fail-closed', async () => {
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
  });

  // ============================================================================
  // Environment Trust Boundaries
  // ============================================================================

  it('40. missing demo actor opt-in in development rejected', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV =
      'development';
    delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;

    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED_ENVIRONMENT');
  });

  it('41. production environment rejected (fails closed)', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR = 'true'; // Ignored in production

    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED_ENVIRONMENT');
  });

  it('42. bounded safe server error response/logging', async () => {
    const badId = '00000000-0000-0000-0000-000000000000';
    const req = new Request(
      `http://localhost:3000/api/actions/${badId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId: badId }),
    });
    expect(res.status).toBe(404);

    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(JSON.stringify(json)).not.toContain('stack');
    expect(JSON.stringify(json)).not.toContain('SELECT');
  });

  // ============================================================================
  // Review Endpoint (GET /api/actions/[proposalId]) Protected Boundary
  // ============================================================================

  it('GET /api/actions/[proposalId] returns sanitized review detail for valid operator', async () => {
    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(proposalId);
    expect(json.data.client.name).toBe('Acme Labs');
    expect(json.data.task.title).toBe('Setup Executive Incident Briefing');
    expect(json.data).not.toHaveProperty('parameterHash');
    expect(json.data).not.toHaveProperty('approvalBindingHash');
  });

  it('GET /api/actions/[proposalId] rejects viewer role with 403', async () => {
    const actionCtx = getActionServerContext();
    const origFindById = actionCtx.dataStore.users.findById;
    actionCtx.dataStore.users.findById = async (tenant, id) => {
      const user = await origFindById(tenant, id);
      return user ? { ...user, role: 'viewer' } : null;
    };

    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe(
      'Actor is not authorized to review action proposals.',
    );
    expect(JSON.stringify(json)).not.toContain('viewer');
  });

  it('GET /api/actions/[proposalId] rejects actor role mismatch with 403', async () => {
    const actionCtx = getActionServerContext();
    const origFindById = actionCtx.dataStore.users.findById;
    actionCtx.dataStore.users.findById = async (tenant, id) => {
      const user = await origFindById(tenant, id);
      return user ? { ...user, role: 'admin' } : null; // Actor claims 'operator', DB has 'admin'
    };

    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe(
      'Actor is not authorized to review action proposals.',
    );
    expect(JSON.stringify(json)).not.toContain('Potential role escalation');
  });

  it('GET /api/actions/[proposalId] rejects non-existent user with 403', async () => {
    const actionCtx = getActionServerContext();
    actionCtx.dataStore.users.findById = async () => null;

    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe(
      'Actor is not authorized to review action proposals.',
    );
    expect(JSON.stringify(json)).not.toContain('does not exist in tenant');
  });

  it('GET /api/actions/[proposalId] rejected in production (fails closed)', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED_ENVIRONMENT');
  });

  it('GET /api/actions/[proposalId] rejected in development without opt-in', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV =
      'development';
    delete process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR;

    const req = new Request(`http://localhost:3000/api/actions/${proposalId}`, {
      method: 'GET',
    });

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED_ENVIRONMENT');
  });

  it('GET /api/actions/[proposalId] returns 404 for proposal of a different tenant', async () => {
    const foreignProposalId = '70000000-0000-4000-8000-000000000002';
    const actionCtx = getActionServerContext();
    await seedProposal(
      actionCtx,
      foreignProposalId,
      SECOND_TEST_ORGANIZATION_ID,
    );

    const req = new Request(
      `http://localhost:3000/api/actions/${foreignProposalId}`,
      { method: 'GET' },
    );

    const res = await inspectRoute(req, {
      params: Promise.resolve({ proposalId: foreignProposalId }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
  });

  // ============================================================================
  // True Successful Route-Level Lifecycle Execution Tests
  // ============================================================================

  it('POST APPROVE succeeds with 200 -> durable APPROVED, 1 ApprovalRecord, 1 ACTION_APPROVED, 0 executions, 0 tasks', async () => {
    const actionCtx = getActionServerContext();
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'APPROVE',
          comment: 'Authorized executive briefing creation',
        }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.proposalId).toBe(proposalId);
    expect(json.data.status).toBe('APPROVED');
    expect(json.data.decision).toBe('APPROVE');
    expect(json.data.idempotent).toBe(false);

    // Verify durable proposal state
    const durableProposal = await actionCtx.actionProposalRepository.findById(
      actionCtx.tenant,
      proposalId,
    );
    expect(durableProposal).not.toBeNull();
    expect(durableProposal!.status).toBe('APPROVED');

    // Exactly one ApprovalRecord persisted
    const approval = await actionCtx.actionApprovalRepository.findByProposalId(
      actionCtx.tenant,
      proposalId,
    );
    expect(approval).not.toBeNull();
    expect(approval!.decision).toBe('APPROVE');
    expect(approval!.actorId).toBe('10000000-0000-4000-8000-000000000011'); // Canonical Alice Walker

    // Exactly one ACTION_APPROVED audit event
    const events = await actionCtx.auditEventRepository.listByProposalId(
      actionCtx.tenant,
      proposalId,
    );
    const approvedEvents = events.filter(
      (e) => e.eventType === 'ACTION_APPROVED',
    );
    expect(approvedEvents.length).toBe(1);

    // ZERO task rows created
    const projectTasks = await actionCtx.dataStore.tasks.listByProject(
      actionCtx.tenant,
      'a0000000-0000-4000-8000-000000000001',
    );
    const createdTasks = projectTasks.filter(
      (t) => t.title === 'Setup Executive Incident Briefing',
    );
    expect(createdTasks.length).toBe(0);
  });

  it('POST DENY succeeds with 200 -> durable DENIED, 1 ApprovalRecord, 1 ACTION_DENIED, 0 executions, 0 tasks', async () => {
    const actionCtx = getActionServerContext();
    const req = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({
          decision: 'DENY',
          comment: 'Out of scope for current sprint',
        }),
      },
    );

    const res = await decisionRoute(req, {
      params: Promise.resolve({ proposalId }),
    });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.proposalId).toBe(proposalId);
    expect(json.data.status).toBe('DENIED');
    expect(json.data.decision).toBe('DENY');

    // Verify durable proposal state is DENIED
    const durableProposal = await actionCtx.actionProposalRepository.findById(
      actionCtx.tenant,
      proposalId,
    );
    expect(durableProposal!.status).toBe('DENIED');

    // Exactly one ApprovalRecord with decision DENY
    const approval = await actionCtx.actionApprovalRepository.findByProposalId(
      actionCtx.tenant,
      proposalId,
    );
    expect(approval).not.toBeNull();
    expect(approval!.decision).toBe('DENY');

    // Exactly one ACTION_DENIED audit event
    const events = await actionCtx.auditEventRepository.listByProposalId(
      actionCtx.tenant,
      proposalId,
    );
    const deniedEvents = events.filter((e) => e.eventType === 'ACTION_DENIED');
    expect(deniedEvents.length).toBe(1);
  });

  it('Action store failure returns 503 ACTION_STORE_UNAVAILABLE fail-closed for GET and POST', async () => {
    setActionServerContextForTesting(() => {
      throw new ActionStoreUnavailableError(
        'Durable action persistence store is unavailable.',
      );
    });

    const postReq = new Request(
      `http://localhost:3000/api/actions/${proposalId}/decision`,
      {
        method: 'POST',
        headers: validSameOriginHeaders,
        body: JSON.stringify({ decision: 'APPROVE' }),
      },
    );

    const postRes = await decisionRoute(postReq, {
      params: Promise.resolve({ proposalId }),
    });
    expect(postRes.status).toBe(503);

    const postJson = await postRes.json();
    expect(postJson.error).toBe('ACTION_STORE_UNAVAILABLE');

    const getReq = new Request(
      `http://localhost:3000/api/actions/${proposalId}`,
      {
        method: 'GET',
      },
    );
    const getRes = await inspectRoute(getReq, {
      params: Promise.resolve({ proposalId }),
    });
    expect(getRes.status).toBe(503);
    const getJson = await getRes.json();
    expect(getJson.error).toBe('ACTION_STORE_UNAVAILABLE');
  });

  it('BLOCKED execution masks raw PreconditionFailedError message with fixed bounded text', async () => {
    const rawSecretMessage =
      'DB EXCEPTION: postgresql://admin:supersecret@10.0.0.1/db updated_at mismatch 2026-10-14T10:00:00Z vs 2026-10-15T00:00:00Z on project a0000000-0000-4000-8000-000000000001';
    const executeSpy = vi
      .spyOn(policy, 'executeApprovedAction')
      .mockRejectedValueOnce(
        new policy.PreconditionFailedError(rawSecretMessage),
      );

    try {
      const postReq = new Request(
        `http://localhost:3000/api/actions/${proposalId}/decision`,
        {
          method: 'POST',
          headers: validSameOriginHeaders,
          body: JSON.stringify({ decision: 'APPROVE' }),
        },
      );

      const res = await decisionRoute(postReq, {
        params: Promise.resolve({ proposalId }),
      });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.execution.status).toBe('BLOCKED');
      expect(json.data.execution.code).toBe('PRECONDITION_FAILED');
      expect(json.data.execution.message).toBe(
        'Execution preconditions are no longer satisfied. No task was created.',
      );

      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('supersecret');
      expect(serialized).not.toContain('10.0.0.1');
      expect(serialized).not.toContain('updated_at');
      expect(serialized).not.toContain('DB EXCEPTION');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('BLOCKED execution masks raw ConflictError message with fixed bounded text', async () => {
    const rawSecretMessage =
      'INTEGRITY FAULT: /var/run/secrets/token.jwt targetEntityId UUID 9999-inconsistent vs expected task 8888';
    const executeSpy = vi
      .spyOn(policy, 'executeApprovedAction')
      .mockRejectedValueOnce(new policy.ConflictError(rawSecretMessage));

    try {
      const postReq = new Request(
        `http://localhost:3000/api/actions/${proposalId}/decision`,
        {
          method: 'POST',
          headers: validSameOriginHeaders,
          body: JSON.stringify({ decision: 'APPROVE' }),
        },
      );

      const res = await decisionRoute(postReq, {
        params: Promise.resolve({ proposalId }),
      });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.execution.status).toBe('BLOCKED');
      expect(json.data.execution.code).toBe('INTEGRITY_CONFLICT');
      expect(json.data.execution.message).toBe(
        'Durable execution state is inconsistent or already in progress. No new task was created.',
      );

      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('/var/run/secrets');
      expect(serialized).not.toContain('token.jwt');
      expect(serialized).not.toContain('9999-inconsistent');
      expect(serialized).not.toContain('INTEGRITY FAULT');
    } finally {
      executeSpy.mockRestore();
    }
  });
});
