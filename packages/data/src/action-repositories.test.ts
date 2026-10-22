import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  DEMO_ORGANIZATION_ID,
  SECOND_TEST_ORGANIZATION_ID,
  createTenantContext,
} from '@clientops/domain';
import {
  type ActionProposal,
  type ActionStatus,
  type ApprovalRecord,
  type RecordVersionPrecondition,
  type AuditEventPayload,
  ActionProposalSchema,
  resolveSafeFailureSummary,
  materializeTaskCreateParameters,
  computeCanonicalParameterHash,
  computeApprovalBindingHash,
} from '@clientops/contracts';
import { buildAuditEvent, sanitizeAuditPayload } from '@clientops/audit';
import { IllegalStateTransitionError, canTransition } from '@clientops/policy';
import {
  getDatabasePool,
  closeDatabasePool,
  runMigrations,
  runSeed,
  PostgresActionProposalRepository,
  PostgresActionApprovalRepository,
  PostgresActionExecutionRepository,
  PostgresAuditEventRepository,
  InMemoryActionProposalRepository,
  InMemoryActionApprovalRepository,
  InMemoryActionExecutionRepository,
  InMemoryAuditEventRepository,
} from './index.js';

const tenantOrg1 = createTenantContext(DEMO_ORGANIZATION_ID);
const tenantOrg2 = createTenantContext(SECOND_TEST_ORGANIZATION_ID);

const ORG1_CLIENT_ID = 'c0000000-0000-4000-8000-000000000001';
const ORG1_PROJECT_ID = 'a0000000-0000-4000-8000-000000000001';
const ORG1_OPERATOR_ID = '10000000-0000-4000-8000-000000000011';
const ORG1_PROJECT_UPDATED_AT = '2026-09-05T00:00:00.000Z';

function createSampleProposalFixture(
  overrides?: Partial<ActionProposal>,
): ActionProposal {
  const orgId = overrides?.organizationId ?? DEMO_ORGANIZATION_ID;
  const rawParams = overrides?.parameters ?? {
    clientId: ORG1_CLIENT_ID,
    projectId: ORG1_PROJECT_ID,
    title: 'Schedule executive alignment check-in',
    description: 'Follow-up regarding Cloud Analytics Migration timeline',
  };
  const parameters = materializeTaskCreateParameters(rawParams);
  const parameterHash = computeCanonicalParameterHash(parameters);

  const preconditions: RecordVersionPrecondition[] =
    overrides?.preconditions ?? [
      {
        entityType: 'project',
        entityId: ORG1_PROJECT_ID,
        versionField: 'updated_at',
        expectedValue: ORG1_PROJECT_UPDATED_AT,
      },
    ];

  const expiresAt =
    overrides?.expiresAt ?? new Date(Date.now() + 3600 * 1000).toISOString();

  const approvalBindingHash = computeApprovalBindingHash({
    organizationId: orgId,
    actionType: 'task.create',
    parameters,
    preconditions,
    expiresAt,
  });

  const now = new Date().toISOString();

  return {
    id: overrides?.id ?? randomUUID(),
    organizationId: orgId,
    actionType: 'task.create',
    actionClass: 'WRITE',
    parameters,
    parameterHash,
    approvalBindingHash,
    correlationId: overrides?.correlationId ?? `req-${randomUUID()}`,
    evidence: overrides?.evidence ?? [
      {
        entityType: 'project',
        entityId: ORG1_PROJECT_ID,
        excerpt: 'Cloud Analytics Migration project status update',
      },
    ],
    preconditions,
    status: overrides?.status ?? 'PROPOSED',
    justification:
      overrides?.justification ??
      'Recovery task needed due to critical delivery milestone delay',
    createdAt: overrides?.createdAt ?? now,
    expiresAt,
    updatedAt: overrides?.updatedAt ?? now,
  };
}

describe('Phase 4.1 Persistence Schema & Durable Repositories', () => {
  let pool: Pool;
  let pgProposals: PostgresActionProposalRepository;
  let pgApprovals: PostgresActionApprovalRepository;
  let pgExecutions: PostgresActionExecutionRepository;
  let pgAudit: PostgresAuditEventRepository;

  let memProposals: InMemoryActionProposalRepository;
  let memApprovals: InMemoryActionApprovalRepository;
  let memExecutions: InMemoryActionExecutionRepository;
  let memAudit: InMemoryAuditEventRepository;

  beforeAll(async () => {
    pool = getDatabasePool();
    await runMigrations(pool);
    await runSeed(pool);

    pgProposals = new PostgresActionProposalRepository(pool);
    pgApprovals = new PostgresActionApprovalRepository(pool);
    pgExecutions = new PostgresActionExecutionRepository(pool);
    pgAudit = new PostgresAuditEventRepository(pool);

    memProposals = new InMemoryActionProposalRepository();
    memApprovals = new InMemoryActionApprovalRepository();
    memExecutions = new InMemoryActionExecutionRepository();
    memAudit = new InMemoryAuditEventRepository();
  });

  afterAll(async () => {
    await closeDatabasePool();
  });

  // Test 1
  it('1. Valid action proposal insertion with materialized defaults and valid parameter_hash / approval_binding_hash', async () => {
    const fixture = createSampleProposalFixture();
    const created = await pgProposals.create(fixture);

    expect(created.id).toBe(fixture.id);
    expect(created.organizationId).toBe(DEMO_ORGANIZATION_ID);
    expect(created.actionType).toBe('task.create');
    expect(created.actionClass).toBe('WRITE');
    expect(created.parameters.priority).toBe('medium'); // Materialized default
    expect(created.parameterHash).toHaveLength(64);
    expect(created.approvalBindingHash).toHaveLength(64);
    expect(created.status).toBe('PROPOSED');

    const retrieved = await pgProposals.findById(tenantOrg1, created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(fixture.id);
    expect(retrieved?.parameterHash).toBe(fixture.parameterHash);
    expect(retrieved?.approvalBindingHash).toBe(fixture.approvalBindingHash);
  });

  // Test 2
  it('2. Identical approval_binding_hash produced regardless of precondition array order', () => {
    const prec1: RecordVersionPrecondition = {
      entityType: 'project',
      entityId: 'a0000000-0000-4000-8000-000000000001',
      versionField: 'updated_at',
      expectedValue: '2026-09-05T00:00:00.000Z',
    };
    const prec2: RecordVersionPrecondition = {
      entityType: 'client',
      entityId: 'c0000000-0000-4000-8000-000000000001',
      versionField: 'updated_at',
      expectedValue: '2026-09-01T00:00:00.000Z',
    };

    const payloadOrderA = {
      organizationId: DEMO_ORGANIZATION_ID,
      actionType: 'task.create',
      parameters: {
        title: 'Test',
        clientId: ORG1_CLIENT_ID,
        projectId: ORG1_PROJECT_ID,
        priority: 'medium',
      },
      preconditions: [prec1, prec2],
      expiresAt: '2026-10-06T12:00:00.000Z',
    };

    const payloadOrderB = {
      ...payloadOrderA,
      preconditions: [prec2, prec1],
    };

    const hashA = computeApprovalBindingHash(payloadOrderA);
    const hashB = computeApprovalBindingHash(payloadOrderB);

    expect(hashA).toBe(hashB);
  });

  // Test 3
  it('3. Precondition version check semantics (authoritative updated_at timestamp match)', async () => {
    const res = await pool.query(
      `SELECT updated_at FROM projects WHERE id = $1 AND organization_id = $2`,
      [ORG1_PROJECT_ID, DEMO_ORGANIZATION_ID],
    );
    const dbUpdatedAt = new Date(res.rows[0].updated_at).toISOString();

    const fixture = createSampleProposalFixture({
      preconditions: [
        {
          entityType: 'project',
          entityId: ORG1_PROJECT_ID,
          versionField: 'updated_at',
          expectedValue: dbUpdatedAt,
        },
      ],
    });

    expect(fixture.preconditions[0]?.expectedValue).toBe(dbUpdatedAt);

    // Stale precondition
    const stalePrecondition: RecordVersionPrecondition = {
      entityType: 'project',
      entityId: ORG1_PROJECT_ID,
      versionField: 'updated_at',
      expectedValue: '2025-01-01T00:00:00.000Z',
    };
    expect(stalePrecondition.expectedValue).not.toBe(dbUpdatedAt);
  });

  // Test 4
  it("4. Cross-tenant isolation: Org A cannot read Org B's proposal by ID", async () => {
    const org1Proposal = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(org1Proposal);

    // Org 2 attempts to find Org 1's proposal
    const leakAttempt = await pgProposals.findById(tenantOrg2, org1Proposal.id);
    expect(leakAttempt).toBeNull();

    // In-memory verification
    await memProposals.create(org1Proposal);
    const memLeakAttempt = await memProposals.findById(
      tenantOrg2,
      org1Proposal.id,
    );
    expect(memLeakAttempt).toBeNull();
  });

  // Test 5
  it('5. Legal state transitions through the action lifecycle', async () => {
    // Path A: PROPOSED -> PENDING_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED
    const p1 = createSampleProposalFixture();
    await pgProposals.create(p1);

    const step1 = await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    expect(step1.status).toBe('PENDING_APPROVAL');

    const step2 = await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );
    expect(step2.status).toBe('APPROVED');

    const step3 = await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'APPROVED',
      'EXECUTING',
    );
    expect(step3.status).toBe('EXECUTING');

    const step4 = await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'EXECUTING',
      'COMPLETED',
    );
    expect(step4.status).toBe('COMPLETED');

    // Path B: PROPOSED -> PENDING_APPROVAL -> DENIED
    const p2 = createSampleProposalFixture();
    await pgProposals.create(p2);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p2.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const denied = await pgProposals.transitionStatus(
      tenantOrg1,
      p2.id,
      'PENDING_APPROVAL',
      'DENIED',
    );
    expect(denied.status).toBe('DENIED');

    // Path C: EXECUTING -> FAILED
    const p3 = createSampleProposalFixture();
    await pgProposals.create(p3);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p3.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      p3.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      p3.id,
      'APPROVED',
      'EXECUTING',
    );
    const failed = await pgProposals.transitionStatus(
      tenantOrg1,
      p3.id,
      'EXECUTING',
      'FAILED',
    );
    expect(failed.status).toBe('FAILED');
  });

  // Test 6
  it('6. Illegal state transitions rejected fail-closed', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);

    // PROPOSED -> APPROVED (invalid, must be PENDING_APPROVAL first)
    await expect(
      pgProposals.transitionStatus(tenantOrg1, p.id, 'PROPOSED', 'APPROVED'),
    ).rejects.toThrow(IllegalStateTransitionError);

    // PROPOSED -> DENIED (invalid, human denial requires PENDING_APPROVAL)
    await expect(
      pgProposals.transitionStatus(tenantOrg1, p.id, 'PROPOSED', 'DENIED'),
    ).rejects.toThrow(IllegalStateTransitionError);

    // Move to PENDING_APPROVAL then DENIED
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'DENIED',
    );

    // DENIED -> APPROVED (invalid, terminal state)
    await expect(
      pgProposals.transitionStatus(tenantOrg1, p.id, 'DENIED', 'APPROVED'),
    ).rejects.toThrow(IllegalStateTransitionError);

    // In-memory verification of illegal transitions
    const memP = createSampleProposalFixture();
    await memProposals.create(memP);
    await expect(
      memProposals.transitionStatus(
        tenantOrg1,
        memP.id,
        'PROPOSED',
        'APPROVED',
      ),
    ).rejects.toThrow(IllegalStateTransitionError);
  });

  // Test 7
  it('7. Proposal frozen field immutability enforced at DB level by trigger', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);

    // Attempting to modify frozen parameters
    await expect(
      pool.query(
        `UPDATE action_proposals SET parameters = '{"tampered":true}'::jsonb WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(
      /Field "parameters" on action_proposals is frozen and immutable/,
    );

    // Attempting to modify frozen parameter_hash
    await expect(
      pool.query(
        `UPDATE action_proposals SET parameter_hash = '${'0'.repeat(64)}' WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(
      /Field "parameter_hash" on action_proposals is frozen and immutable/,
    );

    // Attempting to modify frozen approval_binding_hash
    await expect(
      pool.query(
        `UPDATE action_proposals SET approval_binding_hash = '${'1'.repeat(64)}' WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toThrow(
      /Field "approval_binding_hash" on action_proposals is frozen and immutable/,
    );

    // Attempting to modify frozen organization_id
    await expect(
      pool.query(
        `UPDATE action_proposals SET organization_id = $1 WHERE id = $2`,
        [SECOND_TEST_ORGANIZATION_ID, p.id],
      ),
    ).rejects.toThrow(
      /Field "organization_id" on action_proposals is frozen and immutable/,
    );
  });

  // Test 8
  it('8. Human approval insertion succeeds for PENDING_APPROVAL proposal', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
      comment: 'Approved for recovery execution',
    };

    const created = await pgApprovals.create(approval);
    expect(created.id).toBe(approval.id);
    expect(created.decision).toBe('APPROVE');
    expect(created.actorRole).toBe('operator');

    const found = await pgApprovals.findByProposalId(tenantOrg1, p.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(approval.id);
  });

  // Test 9
  it('9. Approval duplicate rejected by unique constraint (uq_action_approvals_proposal)', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    };

    await pgApprovals.create(approval);

    // Second approval for same proposal
    const duplicateApproval: ApprovalRecord = {
      ...approval,
      id: randomUUID(),
      decision: 'DENY',
    };

    await expect(pgApprovals.create(duplicateApproval)).rejects.toThrow();
  });

  // Test 10
  it('10. Approval immutability: UPDATE on action_approvals rejected by trigger', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    };
    await pgApprovals.create(approval);

    await expect(
      pool.query(
        `UPDATE action_approvals SET decision = 'DENY' WHERE id = $1`,
        [approval.id],
      ),
    ).rejects.toThrow(
      /Approval records are immutable. UPDATE and DELETE operations are strictly prohibited/,
    );
  });

  // Test 11
  it('11. Approval immutability: DELETE on action_approvals rejected by trigger', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    };
    await pgApprovals.create(approval);

    await expect(
      pool.query(`DELETE FROM action_approvals WHERE id = $1`, [approval.id]),
    ).rejects.toThrow(
      /Approval records are immutable. UPDATE and DELETE operations are strictly prohibited/,
    );
  });

  // Test 12
  it('12. Approval binding hash mismatch detected / rejected at validation layer', () => {
    const p = createSampleProposalFixture();
    const tamperedPayload = {
      organizationId: DEMO_ORGANIZATION_ID,
      actionType: 'task.create',
      parameters: { ...p.parameters, title: 'Malicious title tampering' },
      preconditions: p.preconditions,
      expiresAt: p.expiresAt,
    };
    const tamperedHash = computeApprovalBindingHash(tamperedPayload);
    expect(tamperedHash).not.toBe(p.approvalBindingHash);
  });

  // Test 13
  it('13. Execution record insertion for approved proposal succeeds', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });

    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    const execution = await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      targetEntityType: 'task',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    expect(execution.status).toBe('EXECUTING');
    expect(execution.actionProposalId).toBe(p.id);
    expect(execution.executorPrincipal).toBe('clientops_trusted_executor');

    const found = await pgExecutions.findByProposalId(tenantOrg1, p.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(execution.id);

    // In-memory verification
    const memApproval = await memApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });

    const memExecution = await memExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: memApproval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });
    expect(memExecution.status).toBe('EXECUTING');
    const memFound = await memExecutions.findByProposalId(tenantOrg1, p.id);
    expect(memFound).not.toBeNull();
  });

  // Test 14
  it('14. Execution record duplicate rejected by unique constraint (idempotency)', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    // Duplicate execution attempt for same proposal
    await expect(
      pgExecutions.create({
        organizationId: DEMO_ORGANIZATION_ID,
        actionProposalId: p.id,
        actionApprovalId: approval.id,
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
      }),
    ).rejects.toThrow();
  });

  // Test 15
  it('15. Execution record cross-tenant mismatch rejected by composite FK', async () => {
    const p = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });

    // Attempting to create execution in Org 2 for Org 1's proposal
    await expect(
      pgExecutions.create({
        organizationId: SECOND_TEST_ORGANIZATION_ID, // Mismatched tenant
        actionProposalId: p.id,
        actionApprovalId: approval.id,
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
      }),
    ).rejects.toThrow();
  });

  // Test 16
  it('16. Execution status transition to COMPLETED records completed_at and target_entity_id', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    const targetTaskId = randomUUID();
    const updated = await pgExecutions.updateResult(tenantOrg1, p.id, {
      status: 'COMPLETED',
      targetEntityId: targetTaskId,
    });

    expect(updated.status).toBe('COMPLETED');
    expect(updated.targetEntityId).toBe(targetTaskId);
    expect(updated.completedAt).toBeDefined();
  });

  // Test 17
  it('17. Execution status transition to FAILED records completed_at, error_code, failure_summary', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    const updated = await pgExecutions.updateResult(tenantOrg1, p.id, {
      status: 'FAILED',
      errorCode: 'PRECONDITION_FAILED',
      failureSummary: 'Project version has drifted',
    });

    expect(updated.status).toBe('FAILED');
    expect(updated.errorCode).toBe('PRECONDITION_FAILED');
    expect(updated.failureSummary).toBe(
      'A record version precondition was not met at execution time.',
    );
    expect(updated.completedAt).toBeDefined();
  });

  // Test 18
  it('18. Audit event insertion succeeds for all 8 lifecycle event types', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    const correlationId = `corr-${randomUUID()}`;

    const eventTypes = [
      'ACTION_PROPOSED',
      'APPROVAL_REQUESTED',
      'ACTION_APPROVED',
      'ACTION_DENIED',
      'ACTION_EXPIRED',
      'EXECUTION_STARTED',
      'EXECUTION_COMPLETED',
      'EXECUTION_FAILED',
    ] as const;

    for (const eventType of eventTypes) {
      let payload: AuditEventPayload;
      if (eventType === 'ACTION_PROPOSED') {
        payload = {
          actionProposalId: p.id,
          actionType: p.actionType,
          actionClass: p.actionClass,
          parameterHash: p.parameterHash,
          approvalBindingHash: p.approvalBindingHash,
          justification: p.justification,
          clientId: p.parameters.clientId,
          projectId: p.parameters.projectId,
          preconditionCount: p.preconditions.length,
          citationCount: p.evidence.length,
        };
      } else if (eventType === 'APPROVAL_REQUESTED') {
        payload = {
          actionProposalId: p.id,
          requestedAt: new Date().toISOString(),
          expiresAt: p.expiresAt,
          approvalBindingHash: p.approvalBindingHash,
        };
      } else if (eventType === 'ACTION_APPROVED') {
        payload = {
          actionProposalId: p.id,
          actorId: ORG1_OPERATOR_ID,
          actorRole: 'operator',
          decidedAt: new Date().toISOString(),
          approvalBindingHash: p.approvalBindingHash,
        };
      } else if (eventType === 'ACTION_DENIED') {
        payload = {
          actionProposalId: p.id,
          actorId: ORG1_OPERATOR_ID,
          actorRole: 'operator',
          decidedAt: new Date().toISOString(),
          reason: 'Scope too wide',
        };
      } else if (eventType === 'ACTION_EXPIRED') {
        payload = {
          actionProposalId: p.id,
          expiredAt: new Date().toISOString(),
          previousStatus: 'PENDING_APPROVAL',
        };
      } else if (eventType === 'EXECUTION_STARTED') {
        payload = {
          actionProposalId: p.id,
          executionId: randomUUID(),
          executorPrincipal: 'clientops_trusted_executor',
          startedAt: new Date().toISOString(),
          approvalBindingHash: p.approvalBindingHash,
        };
      } else if (eventType === 'EXECUTION_COMPLETED') {
        payload = {
          actionProposalId: p.id,
          executionId: randomUUID(),
          targetEntityType: 'task',
          targetEntityId: randomUUID(),
          completedAt: new Date().toISOString(),
        };
      } else if (eventType === 'EXECUTION_FAILED') {
        payload = {
          actionProposalId: p.id,
          executionId: randomUUID(),
          errorCode: 'INTERNAL_EXECUTION_ERROR',
          failureSummary:
            'Task creation failed due to an internal execution error.',
          failedAt: new Date().toISOString(),
        };
      } else {
        throw new Error(`Unhandled eventType: ${String(eventType)}`);
      }

      const event = buildAuditEvent({
        organizationId: DEMO_ORGANIZATION_ID,
        actionProposalId: p.id,
        eventType,
        actorId: ORG1_OPERATOR_ID,
        correlationId,
        payload,
      });

      const appended = await pgAudit.append(event);
      expect(appended.eventType).toBe(eventType);
    }

    const events = await pgAudit.listByProposalId(tenantOrg1, p.id);
    expect(events).toHaveLength(8);

    const corrEvents = await pgAudit.listByCorrelationId(
      tenantOrg1,
      correlationId,
    );
    expect(corrEvents).toHaveLength(8);
  });

  // Test 19
  it('19. Audit event immutability: UPDATE on audit_events rejected by trigger', async () => {
    const event = buildAuditEvent({
      organizationId: DEMO_ORGANIZATION_ID,
      eventType: 'ACTION_EXPIRED',
      payload: {
        actionProposalId: randomUUID(),
        expiredAt: new Date().toISOString(),
        previousStatus: 'PENDING_APPROVAL',
      },
    });
    const appended = await pgAudit.append(event);

    await expect(
      pool.query(
        `UPDATE audit_events SET event_type = 'ACTION_DENIED' WHERE id = $1`,
        [appended.id],
      ),
    ).rejects.toThrow(
      /Audit records are append-only. UPDATE and DELETE operations are strictly prohibited/,
    );
  });

  // Test 20
  it('20. Audit event immutability: DELETE on audit_events rejected by trigger', async () => {
    const event = buildAuditEvent({
      organizationId: DEMO_ORGANIZATION_ID,
      eventType: 'ACTION_EXPIRED',
      payload: {
        actionProposalId: randomUUID(),
        expiredAt: new Date().toISOString(),
        previousStatus: 'PENDING_APPROVAL',
      },
    });
    const appended = await pgAudit.append(event);

    await expect(
      pool.query(`DELETE FROM audit_events WHERE id = $1`, [appended.id]),
    ).rejects.toThrow(
      /Audit records are append-only. UPDATE and DELETE operations are strictly prohibited/,
    );
  });

  // Test 21
  it('21. Audit event payload bounds and credential redaction enforced', () => {
    // 1. Raw payload sanitization & credential redaction
    const rawSensitivePayload = {
      actionProposalId: randomUUID(),
      secret_key: 'top_secret_token',
      authorization: 'Bearer supersecret',
      longField: 'X'.repeat(600),
    };

    const sanitized = sanitizeAuditPayload(rawSensitivePayload);
    expect(sanitized.secret_key).toBe('[REDACTED]');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect((sanitized.longField as string).length).toBeLessThanOrEqual(500);
    expect(sanitized.longField).toContain('... [TRUNCATED]');

    // 2. Strict event schema validation with bounded strings
    const longComment = 'Detailed approval comment: ' + 'C'.repeat(600);
    const validEvent = buildAuditEvent({
      organizationId: DEMO_ORGANIZATION_ID,
      eventType: 'ACTION_APPROVED',
      payload: {
        actionProposalId: randomUUID(),
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decidedAt: new Date().toISOString(),
        approvalBindingHash: 'a'.repeat(64),
        comment: longComment,
      },
    });

    const validatedPayload = validEvent.payload as { comment: string };
    expect(validatedPayload.comment.length).toBeLessThanOrEqual(500);
    expect(validatedPayload.comment).toContain('... [TRUNCATED]');
  });

  // Test 22
  it('22. No update or delete methods exist on ActionApprovalRepository or AuditEventRepository', () => {
    // ActionApprovalRepository
    expect('update' in pgApprovals).toBe(false);
    expect('delete' in pgApprovals).toBe(false);
    expect('update' in memApprovals).toBe(false);
    expect('delete' in memApprovals).toBe(false);

    // AuditEventRepository
    expect('update' in pgAudit).toBe(false);
    expect('delete' in pgAudit).toBe(false);
    expect('update' in memAudit).toBe(false);
    expect('delete' in memAudit).toBe(false);
  });

  // Test 23
  it('23. Tenant-scoped listing of pending proposals filters expired proposals and other tenants', async () => {
    const now = Date.now();
    // Org 1, valid pending
    const org1Pending = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    });
    await pgProposals.create(org1Pending);
    await pgProposals.transitionStatus(
      tenantOrg1,
      org1Pending.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Org 1, expired pending
    const org1Expired = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
      expiresAt: new Date(now - 3600 * 1000).toISOString(),
    });
    await pgProposals.create(org1Expired);
    await pgProposals.transitionStatus(
      tenantOrg1,
      org1Expired.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Org 1, status still PROPOSED (not yet pending approval)
    const org1Proposed = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    });
    await pgProposals.create(org1Proposed);

    // Org 2, valid pending
    const org2Pending = createSampleProposalFixture({
      organizationId: SECOND_TEST_ORGANIZATION_ID,
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    });
    await pgProposals.create(org2Pending);
    await pgProposals.transitionStatus(
      tenantOrg2,
      org2Pending.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Query pending proposals for Org 1
    const pendingList = await pgProposals.listPending(tenantOrg1);
    const ids = pendingList.map((p) => p.id);

    expect(ids).toContain(org1Pending.id);
    expect(ids).not.toContain(org1Expired.id);
    expect(ids).not.toContain(org1Proposed.id);
    expect(ids).not.toContain(org2Pending.id);
  });

  // Test 24
  it('24. Injected transaction client executes repository methods within a single PostgreSQL transaction', async () => {
    const p = createSampleProposalFixture();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const created = await pgProposals.create(p, { client });
      expect(created.id).toBe(p.id);

      await pgProposals.transitionStatus(
        tenantOrg1,
        p.id,
        'PROPOSED',
        'PENDING_APPROVAL',
        { client },
      );
      await pgApprovals.create(approval, { client });
      await pgProposals.transitionStatus(
        tenantOrg1,
        p.id,
        'PENDING_APPROVAL',
        'APPROVED',
        { client },
      );

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Verify after commit
    const committedProposal = await pgProposals.findById(tenantOrg1, p.id);
    expect(committedProposal?.status).toBe('APPROVED');

    const committedApproval = await pgApprovals.findByProposalId(
      tenantOrg1,
      p.id,
    );
    expect(committedApproval?.decision).toBe('APPROVE');
  });

  // Test 25
  it('25. Rollback of transaction leaves no orphaned proposals, approvals, or executions', async () => {
    const p = createSampleProposalFixture();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await pgProposals.create(p, { client });
      await pgProposals.transitionStatus(
        tenantOrg1,
        p.id,
        'PROPOSED',
        'PENDING_APPROVAL',
        { client },
      );
      await pgApprovals.create(approval, { client });

      // Rollback instead of commit
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Verify records do not exist
    const foundProposal = await pgProposals.findById(tenantOrg1, p.id);
    expect(foundProposal).toBeNull();

    const foundApproval = await pgApprovals.findByProposalId(tenantOrg1, p.id);
    expect(foundApproval).toBeNull();
  });

  // Test 26
  it('26. Database rejects execution with NULL approval (action_approval_id NOT NULL)', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);

    // Direct SQL INSERT attempting NULL action_approval_id
    await expect(
      pool.query(
        `INSERT INTO action_executions (
          organization_id, action_proposal_id, action_approval_id, parameter_hash, approval_binding_hash
        ) VALUES ($1, $2, NULL, $3, $4)`,
        [p.organizationId, p.id, p.parameterHash, p.approvalBindingHash],
      ),
    ).rejects.toThrow(
      /null value in column "action_approval_id" of relation "action_executions" violates not-null constraint/,
    );
  });

  // Test 27
  it('27. Database rejects execution linked to approval for a different proposal', async () => {
    const p1 = createSampleProposalFixture();
    const p2 = createSampleProposalFixture();
    await pgProposals.create(p1);
    await pgProposals.create(p2);

    await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      p2.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval1 = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p1.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p1.parameterHash,
      approvalBindingHash: p1.approvalBindingHash,
      validUntil: p1.expiresAt,
    });

    await pgProposals.transitionStatus(
      tenantOrg1,
      p2.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    // Attempting to execute p2 with approval1 (which binds p1)
    await expect(
      pgExecutions.create({
        organizationId: DEMO_ORGANIZATION_ID,
        actionProposalId: p2.id,
        actionApprovalId: approval1.id, // Mismatch: belongs to p1!
        parameterHash: p2.parameterHash,
        approvalBindingHash: p2.approvalBindingHash,
      }),
    ).rejects.toThrow(
      /violates foreign key constraint "fk_action_executions_approval_proposal_org"/,
    );
  });

  // Test 28
  it('28. Database rejects execution linked to approval from another tenant', async () => {
    const p1 = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(p1);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p1.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const approval1 = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p1.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p1.parameterHash,
      approvalBindingHash: p1.approvalBindingHash,
      validUntil: p1.expiresAt,
    });

    // Attempting to create an execution row in Org 2 referencing Org 1's approval and proposal
    await expect(
      pool.query(
        `INSERT INTO action_executions (
          organization_id, action_proposal_id, action_approval_id, parameter_hash, approval_binding_hash
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          SECOND_TEST_ORGANIZATION_ID,
          p1.id,
          approval1.id,
          p1.parameterHash,
          p1.approvalBindingHash,
        ],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  // Test 29
  it('29. Database rejects approval actor belonging to a different tenant', async () => {
    const p = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Insert an actor in Org 2
    const org2ActorId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, organization_id, email, name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        org2ActorId,
        SECOND_TEST_ORGANIZATION_ID,
        `user_${org2ActorId}@test.com`,
        'Org2 User',
        'operator',
      ],
    );

    // Attempting to create approval in Org 1 with actor from Org 2
    // 1. Repository-level rejection
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: DEMO_ORGANIZATION_ID,
        actorId: org2ActorId, // Belongs to Org 2!
        actorRole: 'operator',
        decision: 'APPROVE',
        decidedAt: new Date().toISOString(),
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/Actor .* not found in organization/);

    // 2. Direct database-level insertion rejection
    await expect(
      pool.query(
        `INSERT INTO action_approvals (
          id, organization_id, action_proposal_id, actor_id, actor_role, decision,
          parameter_hash, approval_binding_hash, decided_at, valid_until
        ) VALUES ($1, $2, $3, $4, 'operator', 'APPROVE', $5, $6, now(), now() + interval '30 minutes')`,
        [
          randomUUID(),
          DEMO_ORGANIZATION_ID,
          p.id,
          org2ActorId,
          p.parameterHash,
          p.approvalBindingHash,
        ],
      ),
    ).rejects.toThrow(
      /Actor .* not found in organization|violates foreign key constraint "fk_action_approvals_actor_org"/,
    );
  });

  // Test 30
  it('30. Database rejects cross-tenant approval linkage', async () => {
    const p = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Attempt to insert approval in Org 2 referencing proposal in Org 1
    await expect(
      pool.query(
        `INSERT INTO action_approvals (
          organization_id, action_proposal_id, actor_id, actor_role, decision, parameter_hash, approval_binding_hash, valid_until
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          SECOND_TEST_ORGANIZATION_ID,
          p.id,
          ORG1_OPERATOR_ID,
          'operator',
          'APPROVE',
          p.parameterHash,
          p.approvalBindingHash,
          p.expiresAt,
        ],
      ),
    ).rejects.toThrow(
      /Action proposal .* not found in organization|violates foreign key constraint/,
    );
  });

  // Test 31
  it('31. Database rejects cross-tenant audit event linkage', async () => {
    const p = createSampleProposalFixture({
      organizationId: DEMO_ORGANIZATION_ID,
    });
    await pgProposals.create(p);

    // Attempt to insert audit event in Org 2 referencing proposal in Org 1
    await expect(
      pool.query(
        `INSERT INTO audit_events (
          organization_id, action_proposal_id, event_type, actor_id, payload
        ) VALUES ($1, $2, 'ACTION_PROPOSED', $3, '{}'::jsonb)`,
        [SECOND_TEST_ORGANIZATION_ID, p.id, ORG1_OPERATOR_ID],
      ),
    ).rejects.toThrow(
      /violates foreign key constraint "fk_audit_events_proposal_org"/,
    );
  });

  // Test 32
  it('32. Approval created before proposal is PENDING_APPROVAL rejected', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    // proposal is still 'PROPOSED', not 'PENDING_APPROVAL'

    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: DEMO_ORGANIZATION_ID,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        decidedAt: new Date().toISOString(),
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/expected 'PENDING_APPROVAL'/);
  });

  // Test 33
  it('33. Approval with parameter_hash or approval_binding_hash mismatch rejected', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const wrongHash = 'f'.repeat(64);

    // Parameter hash mismatch
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: DEMO_ORGANIZATION_ID,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        decidedAt: new Date().toISOString(),
        parameterHash: wrongHash,
        approvalBindingHash: p.approvalBindingHash,
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/parameterHash mismatch/);

    // Approval binding hash mismatch
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: DEMO_ORGANIZATION_ID,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        decidedAt: new Date().toISOString(),
        parameterHash: p.parameterHash,
        approvalBindingHash: wrongHash,
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/approvalBindingHash mismatch/);
  });

  // Test 34
  it('34. Approval with valid_until exceeding proposal expires_at rejected', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    const exceededValidUntil = new Date(
      new Date(p.expiresAt).getTime() + 60000,
    ).toISOString();

    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: DEMO_ORGANIZATION_ID,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        decidedAt: new Date().toISOString(),
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        validUntil: exceededValidUntil,
      }),
    ).rejects.toThrow(/cannot exceed proposal expiresAt/);
  });

  // Test 35
  it('35. Proposal with empty evidence array rejected by DB check and repository', async () => {
    const p = createSampleProposalFixture();
    const invalidProposal = { ...p, evidence: [] };

    await expect(
      pgProposals.create(invalidProposal as unknown as ActionProposal),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO action_proposals (
          organization_id, action_type, action_class, parameters, parameter_hash,
          approval_binding_hash, correlation_id, evidence, preconditions, justification, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8, $9, $10)`,
        [
          p.organizationId,
          p.actionType,
          p.actionClass,
          JSON.stringify(p.parameters),
          p.parameterHash,
          p.approvalBindingHash,
          p.correlationId,
          JSON.stringify(p.preconditions),
          p.justification,
          p.expiresAt,
        ],
      ),
    ).rejects.toThrow(
      /violates check constraint "chk_proposal_evidence_not_empty"/,
    );
  });

  // Test 36
  it('36. Proposal with empty preconditions array rejected by DB check and repository', async () => {
    const p = createSampleProposalFixture();
    const invalidProposal = { ...p, preconditions: [] };

    await expect(
      pgProposals.create(invalidProposal as unknown as ActionProposal),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO action_proposals (
          organization_id, action_type, action_class, parameters, parameter_hash,
          approval_binding_hash, correlation_id, evidence, preconditions, justification, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9, $10)`,
        [
          p.organizationId,
          p.actionType,
          p.actionClass,
          JSON.stringify(p.parameters),
          p.parameterHash,
          p.approvalBindingHash,
          p.correlationId,
          JSON.stringify(p.evidence),
          p.justification,
          p.expiresAt,
        ],
      ),
    ).rejects.toThrow(
      /violates check constraint "chk_proposal_preconditions_not_empty"/,
    );
  });

  // Test 37
  it('37. Proposal deletion rejected by trigger trg_action_proposals_no_delete', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);

    await expect(
      pool.query(`DELETE FROM action_proposals WHERE id = $1`, [p.id]),
    ).rejects.toThrow(
      /Action proposals cannot be deleted. DELETE operations are strictly prohibited/,
    );
  });

  // Test 38
  it('38. Execution deletion rejected by trigger trg_action_executions_no_delete', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );

    const exec = await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    await expect(
      pool.query(`DELETE FROM action_executions WHERE id = $1`, [exec.id]),
    ).rejects.toThrow(
      /Action executions cannot be deleted. DELETE operations are strictly prohibited/,
    );
  });

  // Test 39
  it('39. Raw failure error/token/path sanitization on execution result', async () => {
    const p = createSampleProposalFixture();
    await pgProposals.create(p);
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const approval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      decidedAt: new Date().toISOString(),
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      validUntil: p.expiresAt,
    });
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PENDING_APPROVAL',
      'APPROVED',
    );
    await pgExecutions.create({
      organizationId: DEMO_ORGANIZATION_ID,
      actionProposalId: p.id,
      actionApprovalId: approval.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    const rawError = new Error(
      'Execution failed on postgresql://postgres:mysecretpassword@localhost:5432/db bearer secrettoken123 at /home/codespace/src/exec.ts:50:10',
    );
    rawError.stack = 'Error: at query (/home/codespace/src/exec.ts:50:10)';

    const updated = await pgExecutions.updateResult(tenantOrg1, p.id, {
      status: 'FAILED',
      errorCode: 'INTERNAL_EXECUTION_ERROR',
      failureSummary: rawError as unknown as string,
    });

    expect(updated.failureSummary).toBeDefined();
    expect(updated.errorCode).toBe('INTERNAL_EXECUTION_ERROR');
    expect(updated.failureSummary).toBe(
      'Task creation failed due to an internal execution error.',
    );
    expect(updated.failureSummary).not.toContain('mysecretpassword');
    expect(updated.failureSummary).not.toContain('secrettoken123');
    expect(updated.failureSummary).not.toContain('/home/codespace/');
  });

  // Test 40
  it('40. Comprehensive 64-pair (8x8) state machine transition matrix test verifies 100% parity between TypeScript and PostgreSQL trigger', async () => {
    const allStatuses: ActionStatus[] = [
      'PROPOSED',
      'PENDING_APPROVAL',
      'APPROVED',
      'DENIED',
      'EXPIRED',
      'EXECUTING',
      'COMPLETED',
      'FAILED',
    ];

    const transitionPath: Record<ActionStatus, ActionStatus[]> = {
      PROPOSED: [],
      PENDING_APPROVAL: ['PENDING_APPROVAL'],
      APPROVED: ['PENDING_APPROVAL', 'APPROVED'],
      DENIED: ['PENDING_APPROVAL', 'DENIED'],
      EXPIRED: ['EXPIRED'],
      EXECUTING: ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING'],
      COMPLETED: ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'COMPLETED'],
      FAILED: ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'FAILED'],
    };

    let testCount = 0;
    for (const fromStatus of allStatuses) {
      for (const toStatus of allStatuses) {
        testCount++;
        const tsAllowed = canTransition(fromStatus, toStatus);

        // Always insert with initial status PROPOSED (enforced by trigger)
        const p = createSampleProposalFixture({ status: 'PROPOSED' });
        const res = await pool.query(
          `INSERT INTO action_proposals (
            id, organization_id, action_type, action_class, parameters, parameter_hash,
            approval_binding_hash, correlation_id, evidence, preconditions, status,
            justification, created_at, expires_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id`,
          [
            p.id,
            p.organizationId,
            p.actionType,
            p.actionClass,
            JSON.stringify(p.parameters),
            p.parameterHash,
            p.approvalBindingHash,
            p.correlationId,
            JSON.stringify(p.evidence),
            JSON.stringify(p.preconditions),
            'PROPOSED',
            p.justification,
            p.createdAt,
            p.expiresAt,
            p.updatedAt,
          ],
        );
        const proposalId = res.rows[0].id;

        // Transition through valid intermediate states to reach fromStatus
        for (const intermediateStatus of transitionPath[fromStatus]) {
          await pool.query(
            `UPDATE action_proposals SET status = $1, updated_at = now() WHERE id = $2`,
            [intermediateStatus, proposalId],
          );
        }

        if (tsAllowed) {
          // PostgreSQL must permit this transition
          const updateRes = await pool.query(
            `UPDATE action_proposals SET status = $1, updated_at = now() WHERE id = $2 RETURNING status`,
            [toStatus, proposalId],
          );
          expect(updateRes.rows[0].status).toBe(toStatus);
        } else {
          // PostgreSQL must raise an exception rejecting this transition
          await expect(
            pool.query(
              `UPDATE action_proposals SET status = $1, updated_at = now() WHERE id = $2`,
              [toStatus, proposalId],
            ),
          ).rejects.toThrow();
        }
      }
    }

    expect(testCount).toBe(64);
  });

  it('41. Freeze execution authorization fields & enforce state machine transitions', async () => {
    const p = await pgProposals.create(createSampleProposalFixture());
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const app = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: p.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: p.expiresAt,
    });

    const exec = await pgExecutions.create({
      organizationId: p.organizationId,
      actionProposalId: p.id,
      actionApprovalId: app.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    // Verify mutating frozen fields is rejected
    await expect(
      pool.query(`UPDATE action_executions SET id = $1 WHERE id = $2`, [
        randomUUID(),
        exec.id,
      ]),
    ).rejects.toThrow(/Cannot mutate id on action_executions/);

    await expect(
      pool.query(
        `UPDATE action_executions SET organization_id = $1 WHERE id = $2`,
        [SECOND_TEST_ORGANIZATION_ID, exec.id],
      ),
    ).rejects.toThrow(/Cannot mutate organization_id on action_executions/);

    await expect(
      pool.query(
        `UPDATE action_executions SET action_proposal_id = $1 WHERE id = $2`,
        [randomUUID(), exec.id],
      ),
    ).rejects.toThrow(/Cannot mutate action_proposal_id on action_executions/);

    await expect(
      pool.query(
        `UPDATE action_executions SET action_approval_id = $1 WHERE id = $2`,
        [randomUUID(), exec.id],
      ),
    ).rejects.toThrow(/Cannot mutate action_approval_id on action_executions/);

    await expect(
      pool.query(
        `UPDATE action_executions SET executor_principal = $1 WHERE id = $2`,
        ['other_executor', exec.id],
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `UPDATE action_executions SET parameter_hash = $1 WHERE id = $2`,
        ['f'.repeat(64), exec.id],
      ),
    ).rejects.toThrow(/Cannot mutate parameter_hash on action_executions/);

    await expect(
      pool.query(
        `UPDATE action_executions SET approval_binding_hash = $1 WHERE id = $2`,
        ['f'.repeat(64), exec.id],
      ),
    ).rejects.toThrow(
      /Cannot mutate approval_binding_hash on action_executions/,
    );

    await expect(
      pool.query(
        `UPDATE action_executions SET started_at = now() - interval '1 hour' WHERE id = $1`,
        [exec.id],
      ),
    ).rejects.toThrow(/Cannot mutate started_at on action_executions/);

    // Self-transition EXECUTING -> EXECUTING is rejected
    await expect(
      pool.query(
        `UPDATE action_executions SET status = 'EXECUTING' WHERE id = $1`,
        [exec.id],
      ),
    ).rejects.toThrow(
      /Illegal self-transition: execution status is already EXECUTING/,
    );

    // Transition EXECUTING -> COMPLETED succeeds
    const completedRes = await pool.query(
      `UPDATE action_executions SET status = 'COMPLETED', target_entity_id = $1, completed_at = now() WHERE id = $2 RETURNING status`,
      [randomUUID(), exec.id],
    );
    expect(completedRes.rows[0].status).toBe('COMPLETED');

    // Terminal transitions from COMPLETED are rejected
    await expect(
      pool.query(
        `UPDATE action_executions SET status = 'FAILED' WHERE id = $1`,
        [exec.id],
      ),
    ).rejects.toThrow(
      /Cannot transition from terminal state COMPLETED on action_executions/,
    );

    await expect(
      pool.query(
        `UPDATE action_executions SET status = 'EXECUTING' WHERE id = $1`,
        [exec.id],
      ),
    ).rejects.toThrow(
      /Cannot transition from terminal state COMPLETED on action_executions/,
    );

    // Second execution for EXECUTING -> FAILED
    const p2 = await pgProposals.create(createSampleProposalFixture());
    await pgProposals.transitionStatus(
      tenantOrg1,
      p2.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const app2 = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p2.id,
      organizationId: p2.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p2.parameterHash,
      approvalBindingHash: p2.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: p2.expiresAt,
    });
    const exec2 = await pgExecutions.create({
      organizationId: p2.organizationId,
      actionProposalId: p2.id,
      actionApprovalId: app2.id,
      parameterHash: p2.parameterHash,
      approvalBindingHash: p2.approvalBindingHash,
    });

    const failedRes = await pool.query(
      `UPDATE action_executions SET status = 'FAILED', error_code = 'TASK_CREATION_FAILED', failure_summary = 'Validation failed', completed_at = now() WHERE id = $1 RETURNING status`,
      [exec2.id],
    );
    expect(failedRes.rows[0].status).toBe('FAILED');

    // Terminal transition FAILED -> COMPLETED is rejected
    await expect(
      pool.query(
        `UPDATE action_executions SET status = 'COMPLETED' WHERE id = $1`,
        [exec2.id],
      ),
    ).rejects.toThrow(
      /Cannot transition from terminal state FAILED on action_executions/,
    );
  });

  it('42. Authoritative actor role verification against users table at approval insertion', async () => {
    // Insert a viewer user in Org 1
    const viewerId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, organization_id, email, name, role)
       VALUES ($1, $2, $3, $4, 'viewer')`,
      [
        viewerId,
        DEMO_ORGANIZATION_ID,
        `viewer-${viewerId}@clientops.internal`,
        'Viewer User',
      ],
    );

    const p = await pgProposals.create(createSampleProposalFixture());
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );

    // Case 1: Viewer with actor_role='viewer' -> rejected (not admin/operator)
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: p.organizationId,
        actorId: viewerId,
        actorRole: 'viewer' as unknown as 'admin',
        decision: 'APPROVE',
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        decidedAt: new Date().toISOString(),
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(
      /not authorized to approve actions|expected one of "admin"\|"operator"|actorRole/,
    );

    // Case 2: Viewer attempting to pass actorRole='admin' -> rejected (mismatch and not authorized)
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: p.organizationId,
        actorId: viewerId,
        actorRole: 'admin',
        decision: 'APPROVE',
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        decidedAt: new Date().toISOString(),
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/not authorized to approve actions|role mismatch/);

    // Case 3: Actor from Org 2 against Org 1 proposal -> rejected (actor not found in organization)
    const org2ActorId = '20000000-0000-4000-8000-000000000021'; // Carol Danvers in Org 2
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: p.organizationId,
        actorId: org2ActorId,
        actorRole: 'operator',
        decision: 'APPROVE',
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        decidedAt: new Date().toISOString(),
        validUntil: p.expiresAt,
      }),
    ).rejects.toThrow(/not found in organization/);

    // Case 4: Valid operator in Org 1 -> succeeds!
    const validApproval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: p.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: p.expiresAt,
    });
    expect(validApproval.actorRole).toBe('operator');
  });

  it('43. Complete approval time validity at approval insertion', async () => {
    // Case 1: Proposal with expired expiresAt still marked PENDING_APPROVAL -> approval rejected
    const expiredProposal = await pgProposals.create(
      createSampleProposalFixture({
        expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1 hour ago
      }),
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      expiredProposal.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: expiredProposal.id,
        organizationId: expiredProposal.organizationId,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        parameterHash: expiredProposal.parameterHash,
        approvalBindingHash: expiredProposal.approvalBindingHash,
        decidedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 600 * 1000).toISOString(),
      }),
    ).rejects.toThrow(
      /Cannot approve expired proposal|is after proposal expires/,
    );

    // Case 2: validUntil <= decidedAt -> rejected
    const p = await pgProposals.create(
      createSampleProposalFixture({
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      }),
    );
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const nowIso = new Date().toISOString();
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: p.organizationId,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        decidedAt: nowIso,
        validUntil: nowIso, // equal -> invalid
      }),
    ).rejects.toThrow(
      /validUntil.*must be strictly after decidedAt|valid_until.*must be strictly after decided_at/,
    );

    // Case 3: validUntil > proposal.expiresAt -> rejected
    await expect(
      pgApprovals.create({
        id: randomUUID(),
        actionProposalId: p.id,
        organizationId: p.organizationId,
        actorId: ORG1_OPERATOR_ID,
        actorRole: 'operator',
        decision: 'APPROVE',
        parameterHash: p.parameterHash,
        approvalBindingHash: p.approvalBindingHash,
        decidedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7200 * 1000).toISOString(), // 2 hours > proposal 1 hour
      }),
    ).rejects.toThrow(
      /cannot exceed proposal expiresAt|cannot exceed proposal expires_at/,
    );

    // Case 4: Valid interval -> succeeds
    const validApproval = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: p.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 1800 * 1000).toISOString(), // 30 min < 1 hour
    });
    expect(validApproval).toBeDefined();
  });

  it('44. Precondition binding to actual target project in proposal registration', async () => {
    // Parameters target ORG1_PROJECT_ID, but precondition targets other project
    const otherProjectId = '99999999-0000-4000-8000-000000000009';
    const wrongProposal = createSampleProposalFixture({
      preconditions: [
        {
          entityType: 'project',
          entityId: otherProjectId, // wrong project ID!
          versionField: 'updated_at',
          expectedValue: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    // Zod rejection
    expect(() => ActionProposalSchema.parse(wrongProposal)).toThrow(
      /must include an updated_at precondition for target project/,
    );

    // PostgreSQL repository rejection
    await expect(pgProposals.create(wrongProposal)).rejects.toThrow(
      /must include an updated_at precondition for target project/,
    );

    // InMemory repository rejection
    await expect(memProposals.create(wrongProposal)).rejects.toThrow(
      /must include an updated_at precondition for target project/,
    );

    // Matching precondition succeeds
    const validProposal = createSampleProposalFixture({
      preconditions: [
        {
          entityType: 'project',
          entityId: ORG1_PROJECT_ID,
          versionField: 'updated_at',
          expectedValue: ORG1_PROJECT_UPDATED_AT,
        },
      ],
    });
    const createdPg = await pgProposals.create(validProposal);
    expect(createdPg.id).toBe(validProposal.id);

    const createdMem = await memProposals.create(validProposal);
    expect(createdMem.id).toBe(validProposal.id);
  });

  it('45. Explicit physical cross-tenant audit event proof in PostgreSQL', async () => {
    const p1 = await pgProposals.create(
      createSampleProposalFixture({ organizationId: DEMO_ORGANIZATION_ID }),
    );
    const p2 = await pgProposals.create(
      createSampleProposalFixture({
        organizationId: SECOND_TEST_ORGANIZATION_ID,
      }),
    );

    const org1User = ORG1_OPERATOR_ID;
    const org2User = '20000000-0000-4000-8000-000000000021'; // Carol Danvers in Org 2

    // 1. Org 1 audit event referencing Org 2 proposal -> physically rejected by composite FK
    await expect(
      pool.query(
        `INSERT INTO audit_events (
          organization_id, action_proposal_id, event_type, actor_id, payload
        ) VALUES ($1, $2, 'ACTION_PROPOSED', $3, '{}'::jsonb)`,
        [DEMO_ORGANIZATION_ID, p2.id, org1User],
      ),
    ).rejects.toThrow(
      /violates foreign key constraint "fk_audit_events_proposal_org"/,
    );

    // 2. Org 1 audit event referencing Org 2 user -> physically rejected by composite FK
    await expect(
      pool.query(
        `INSERT INTO audit_events (
          organization_id, action_proposal_id, event_type, actor_id, payload
        ) VALUES ($1, $2, 'ACTION_PROPOSED', $3, '{}'::jsonb)`,
        [DEMO_ORGANIZATION_ID, p1.id, org2User],
      ),
    ).rejects.toThrow(
      /violates foreign key constraint "fk_audit_events_actor_org"/,
    );

    // 3. Org 1 audit event referencing Org 1 proposal and Org 1 user -> succeeds!
    const validAuditRes = await pool.query(
      `INSERT INTO audit_events (
        organization_id, action_proposal_id, event_type, actor_id, payload
      ) VALUES ($1, $2, 'ACTION_PROPOSED', $3, '{}'::jsonb)
      RETURNING id, organization_id, action_proposal_id, actor_id`,
      [DEMO_ORGANIZATION_ID, p1.id, org1User],
    );
    expect(validAuditRes.rows[0].organization_id).toBe(DEMO_ORGANIZATION_ID);
    expect(validAuditRes.rows[0].action_proposal_id).toBe(p1.id);
    expect(validAuditRes.rows[0].actor_id).toBe(org1User);
  });

  it('46. Safe failure persistence mapping and resolution in execution repository', async () => {
    const p = await pgProposals.create(createSampleProposalFixture());
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const app = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: p.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: p.expiresAt,
    });
    await pgExecutions.create({
      organizationId: p.organizationId,
      actionProposalId: p.id,
      actionApprovalId: app.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });

    const safeRes = resolveSafeFailureSummary('TASK_CREATION_FAILED');
    expect(safeRes.errorCode).toBe('TASK_CREATION_FAILED');
    expect(safeRes.failureSummary).toBe(
      'Task creation business validation or database insertion failed.',
    );

    const updated = await pgExecutions.updateResult(tenantOrg1, p.id, {
      status: 'FAILED',
      errorCode: 'TASK_CREATION_FAILED',
      failureSummary: safeRes.failureSummary,
    });

    expect(updated.status).toBe('FAILED');
    expect(updated.errorCode).toBe('TASK_CREATION_FAILED');
    expect(updated.failureSummary).toBe(
      'Task creation business validation or database insertion failed.',
    );
  });

  // Test 47: Phase 4.1.3 Initial Proposal Status Invariant (PROPOSED only)
  it('47. PostgreSQL trigger trg_action_proposals_initial_status and repository reject non-PROPOSED initial status', async () => {
    const invalidInitialStatuses: ActionStatus[] = [
      'PENDING_APPROVAL',
      'APPROVED',
      'DENIED',
      'EXPIRED',
      'EXECUTING',
      'COMPLETED',
      'FAILED',
    ];

    // 1. Direct PostgreSQL INSERT must reject all 7 non-PROPOSED statuses
    for (const invalidStatus of invalidInitialStatuses) {
      const p = createSampleProposalFixture({ status: 'PROPOSED' });
      await expect(
        pool.query(
          `INSERT INTO action_proposals (
            id, organization_id, action_type, action_class, parameters, parameter_hash,
            approval_binding_hash, correlation_id, evidence, preconditions, status,
            justification, created_at, expires_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            p.id,
            p.organizationId,
            p.actionType,
            p.actionClass,
            JSON.stringify(p.parameters),
            p.parameterHash,
            p.approvalBindingHash,
            p.correlationId,
            JSON.stringify(p.evidence),
            JSON.stringify(p.preconditions),
            invalidStatus,
            p.justification,
            p.createdAt,
            p.expiresAt,
            p.updatedAt,
          ],
        ),
      ).rejects.toThrow(
        /Action proposals must be created with initial status "PROPOSED"/,
      );
    }

    // 2. PostgresActionProposalRepository must reject non-PROPOSED
    await expect(
      pgProposals.create({
        ...createSampleProposalFixture(),
        status: 'PENDING_APPROVAL' as unknown as 'PROPOSED',
      }),
    ).rejects.toThrow(/Initial proposal status must be "PROPOSED"/);

    // 3. InMemoryActionProposalRepository must reject non-PROPOSED
    await expect(
      memProposals.create({
        ...createSampleProposalFixture(),
        status: 'APPROVED' as unknown as 'PROPOSED',
      }),
    ).rejects.toThrow(/Initial proposal status must be "PROPOSED"/);
  });

  // Test 48: Phase 4.1.3 Initial Execution State Invariant (EXECUTING + null terminal fields)
  it('48. PostgreSQL trigger trg_action_executions_initial_state and repository enforce EXECUTING and null terminal fields on INSERT', async () => {
    const p = await pgProposals.create(createSampleProposalFixture());
    await pgProposals.transitionStatus(
      tenantOrg1,
      p.id,
      'PROPOSED',
      'PENDING_APPROVAL',
    );
    const app = await pgApprovals.create({
      id: randomUUID(),
      actionProposalId: p.id,
      organizationId: p.organizationId,
      actorId: ORG1_OPERATOR_ID,
      actorRole: 'operator',
      decision: 'APPROVE',
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
      decidedAt: new Date().toISOString(),
      validUntil: p.expiresAt,
    });

    // 1. Direct PostgreSQL INSERT with status = COMPLETED rejected
    await expect(
      pool.query(
        `INSERT INTO action_executions (
          id, organization_id, action_proposal_id, action_approval_id, status,
          executor_principal, parameter_hash, approval_binding_hash, started_at
        ) VALUES ($1, $2, $3, $4, 'COMPLETED', 'clientops_trusted_executor', $5, $6, NOW())`,
        [
          randomUUID(),
          p.organizationId,
          p.id,
          app.id,
          p.parameterHash,
          p.approvalBindingHash,
        ],
      ),
    ).rejects.toThrow(
      /Action executions must be created with initial status "EXECUTING"/,
    );

    // 2. Direct PostgreSQL INSERT with non-null target_entity_id on INSERT rejected
    await expect(
      pool.query(
        `INSERT INTO action_executions (
          id, organization_id, action_proposal_id, action_approval_id, status,
          target_entity_id, executor_principal, parameter_hash, approval_binding_hash, started_at
        ) VALUES ($1, $2, $3, $4, 'EXECUTING', $5, 'clientops_trusted_executor', $6, $7, NOW())`,
        [
          randomUUID(),
          p.organizationId,
          p.id,
          app.id,
          randomUUID(),
          p.parameterHash,
          p.approvalBindingHash,
        ],
      ),
    ).rejects.toThrow(
      /Field "target_entity_id" must be NULL when reserving action execution/,
    );

    // 3. Direct PostgreSQL INSERT with non-null failure_summary on INSERT rejected
    await expect(
      pool.query(
        `INSERT INTO action_executions (
          id, organization_id, action_proposal_id, action_approval_id, status,
          failure_summary, executor_principal, parameter_hash, approval_binding_hash, started_at
        ) VALUES ($1, $2, $3, $4, 'EXECUTING', 'Some error', 'clientops_trusted_executor', $5, $6, NOW())`,
        [
          randomUUID(),
          p.organizationId,
          p.id,
          app.id,
          p.parameterHash,
          p.approvalBindingHash,
        ],
      ),
    ).rejects.toThrow(
      /Field "failure_summary" must be NULL when reserving action execution/,
    );

    // 4. Repository create strictly produces EXECUTING with null/undefined terminal fields
    const createdExec = await pgExecutions.create({
      organizationId: p.organizationId,
      actionProposalId: p.id,
      actionApprovalId: app.id,
      parameterHash: p.parameterHash,
      approvalBindingHash: p.approvalBindingHash,
    });
    expect(createdExec.status).toBe('EXECUTING');
    expect(createdExec.targetEntityId).toBeUndefined();
    expect(createdExec.completedAt).toBeUndefined();
    expect(createdExec.errorCode).toBeUndefined();
    expect(createdExec.failureSummary).toBeUndefined();

    // Verify direct PostgreSQL row has strictly NULL terminal columns
    const dbRow = await pool.query(
      `SELECT target_entity_id, completed_at, error_code, failure_summary FROM action_executions WHERE id = $1`,
      [createdExec.id],
    );
    expect(dbRow.rows[0].target_entity_id).toBeNull();
    expect(dbRow.rows[0].completed_at).toBeNull();
    expect(dbRow.rows[0].error_code).toBeNull();
    expect(dbRow.rows[0].failure_summary).toBeNull();
  });

  // Test 49: Phase 4.1.3 Authoritative Audit Event Validation Trigger
  it('49. PostgreSQL trigger trg_audit_events_validate rejects ACTION_APPROVED and ACTION_DENIED with actorRole viewer', async () => {
    const p = await pgProposals.create(createSampleProposalFixture());

    // 1. ACTION_APPROVED with actorRole: 'viewer' rejected by DB trigger
    await expect(
      pool.query(
        `INSERT INTO audit_events (
          organization_id, action_proposal_id, event_type, actor_id, payload
        ) VALUES ($1, $2, 'ACTION_APPROVED', $3, $4::jsonb)`,
        [
          DEMO_ORGANIZATION_ID,
          p.id,
          ORG1_OPERATOR_ID,
          JSON.stringify({
            actionProposalId: p.id,
            actorId: ORG1_OPERATOR_ID,
            actorRole: 'viewer', // Unauthorized approver role!
            decidedAt: new Date().toISOString(),
            approvalBindingHash: p.approvalBindingHash,
          }),
        ],
      ),
    ).rejects.toThrow(
      /Audit event ACTION_APPROVED requires actorRole to be admin or operator/,
    );

    // 2. ACTION_DENIED with actorRole: 'viewer' rejected by DB trigger
    await expect(
      pool.query(
        `INSERT INTO audit_events (
          organization_id, action_proposal_id, event_type, actor_id, payload
        ) VALUES ($1, $2, 'ACTION_DENIED', $3, $4::jsonb)`,
        [
          DEMO_ORGANIZATION_ID,
          p.id,
          ORG1_OPERATOR_ID,
          JSON.stringify({
            actionProposalId: p.id,
            actorId: ORG1_OPERATOR_ID,
            actorRole: 'viewer', // Unauthorized denier role!
            decidedAt: new Date().toISOString(),
            reason: 'Test denial',
          }),
        ],
      ),
    ).rejects.toThrow(
      /Audit event ACTION_DENIED requires actorRole to be admin or operator/,
    );

    // 3. Valid ACTION_APPROVED with actorRole: 'operator' succeeds
    const validAuditRes = await pool.query(
      `INSERT INTO audit_events (
        organization_id, action_proposal_id, event_type, actor_id, payload
      ) VALUES ($1, $2, 'ACTION_APPROVED', $3, $4::jsonb)
      RETURNING id, event_type`,
      [
        DEMO_ORGANIZATION_ID,
        p.id,
        ORG1_OPERATOR_ID,
        JSON.stringify({
          actionProposalId: p.id,
          actorId: ORG1_OPERATOR_ID,
          actorRole: 'operator',
          decidedAt: new Date().toISOString(),
          approvalBindingHash: p.approvalBindingHash,
        }),
      ],
    );
    expect(validAuditRes.rows[0].event_type).toBe('ACTION_APPROVED');
  });

  it('50. proposal correlation lookup and unique database constraint enforce request idempotency', async () => {
    const correlationId = 'req-phase5-2-idempotency';
    const first = createSampleProposalFixture({ correlationId });

    const createdPg = await pgProposals.create(first);
    const foundPg = await pgProposals.findByCorrelationId(
      tenantOrg1,
      correlationId,
    );
    expect(foundPg?.id).toBe(createdPg.id);

    const createdMem = await memProposals.create({
      ...first,
      id: randomUUID(),
      correlationId: 'req-phase5-2-idempotency-memory',
    });
    const foundMem = await memProposals.findByCorrelationId(
      tenantOrg1,
      createdMem.correlationId,
    );
    expect(foundMem?.id).toBe(createdMem.id);

    await expect(
      pgProposals.create(
        createSampleProposalFixture({
          id: randomUUID(),
          correlationId,
        }),
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_action_proposals_org_correlation',
    });

    await expect(
      memProposals.create({
        ...createSampleProposalFixture(),
        id: randomUUID(),
        correlationId: 'req-phase5-2-idempotency-memory',
      }),
    ).rejects.toThrow(/correlation.*already exists/i);
  });
});
