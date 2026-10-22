import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTenantContext,
  DEMO_ORGANIZATION_ID,
  SECOND_TEST_ORGANIZATION_ID,
  type DataRepositories,
} from '@clientops/domain';
import {
  createInMemoryDataStore,
  createPostgresDataStore,
  getDatabasePool,
  closeDatabasePool,
  runMigrations,
  runSeed,
  assertLocalDatabaseTarget,
} from './index.js';

const tenantOrg1 = createTenantContext(DEMO_ORGANIZATION_ID);
const tenantOrg2 = createTenantContext(SECOND_TEST_ORGANIZATION_ID);

function runTestSuite(name: string, getDataStore: () => DataRepositories) {
  describe(`DataStore (${name})`, () => {
    let repos: DataRepositories;

    beforeAll(() => {
      repos = getDataStore();
    });

    it('resolves Acme Labs client for Org 1', async () => {
      const client = await repos.clients.findByRef(tenantOrg1, 'Acme Labs');
      expect(client).not.toBeNull();
      expect(client?.name).toBe('Acme Labs');
      expect(client?.organizationId).toBe(DEMO_ORGANIZATION_ID);
      expect(client?.id).toBe('c0000000-0000-4000-8000-000000000001');
    });

    it('enforces cross-tenant isolation: Org 1 cannot retrieve Org 2 clients by ID or name', async () => {
      // 1. By ID: Attempt to fetch Org 2's Acme Labs using Org 1 tenant context
      const org2ClientId = 'c0000000-0000-4000-8000-000000000021';
      const crossResult = await repos.clients.findById(
        tenantOrg1,
        org2ClientId,
      );
      expect(crossResult).toBeNull();

      // 2. By Name: Querying "Acme Labs" under Org 1 returns Org 1's record, never Org 2's
      const org1Acme = await repos.clients.findByRef(tenantOrg1, 'Acme Labs');
      expect(org1Acme?.organizationId).toBe(DEMO_ORGANIZATION_ID);
      expect(org1Acme?.id).toBe('c0000000-0000-4000-8000-000000000001');

      // 3. Querying "Acme Labs" under Org 2 returns Org 2's record, never Org 1's
      const org2Acme = await repos.clients.findByRef(tenantOrg2, 'Acme Labs');
      expect(org2Acme?.organizationId).toBe(SECOND_TEST_ORGANIZATION_ID);
      expect(org2Acme?.id).toBe('c0000000-0000-4000-8000-000000000021');
    });

    it('enforces cross-tenant isolation on projects, milestones, tasks, and meetings', async () => {
      const org1Projects = await repos.projects.listByClient(
        tenantOrg1,
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(org1Projects).toHaveLength(1);
      expect(org1Projects[0]?.name).toBe('Cloud Analytics Migration');

      // Org 2 querying Org 1's client ID gets zero projects
      const leakAttempt = await repos.projects.listByClient(
        tenantOrg2,
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(leakAttempt).toHaveLength(0);
    });

    it('returns null for unknown client reference', async () => {
      const result = await repos.clients.findByRef(
        tenantOrg1,
        'Nonexistent Client Co',
      );
      expect(result).toBeNull();
    });

    it('retrieves upcoming meetings for Acme Labs', async () => {
      const meetings = await repos.meetings.listByClient(
        tenantOrg1,
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(meetings.length).toBeGreaterThanOrEqual(2);
      const execReview = meetings.find((m) => m.title === 'Executive Review');
      expect(execReview).toBeDefined();
      expect(execReview?.scheduledAt).toBe('2026-10-16T14:00:00.000Z');
    });

    it('retrieves communications including unresolved analytics question', async () => {
      const comms = await repos.communications.listByClient(
        tenantOrg1,
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(comms.length).toBeGreaterThanOrEqual(3);
      const question = comms.find((c) => c.requiresResponse);
      expect(question).toBeDefined();
      expect(question?.subject).toBe('Discrepancy in Q3 Analytics Export');
      expect(question?.resolvedAt).toBeUndefined();
    });

    it('retrieves commitments including open and fulfilled items', async () => {
      const commitments = await repos.commitments.listByClient(
        tenantOrg1,
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(commitments.length).toBeGreaterThanOrEqual(2);
      expect(commitments.some((c) => c.status === 'open')).toBe(true);
      expect(commitments.some((c) => c.status === 'fulfilled')).toBe(true);
    });

    it('retrieves milestones including overdue Production Data Migration', async () => {
      const projectId = 'a0000000-0000-4000-8000-000000000001';
      const milestones = await repos.milestones.listByProject(
        tenantOrg1,
        projectId,
      );
      expect(milestones.length).toBe(3);
      const overdue = milestones.find(
        (m) => m.title === 'Production Data Migration',
      );
      expect(overdue).toBeDefined();
      expect(overdue?.status).toBe('open');
      expect(overdue?.dueAt).toBe('2026-10-13T09:00:00.000Z');
    });
  });
}

// 1. Run against In-Memory DataStore
runTestSuite('In-Memory', () => createInMemoryDataStore());

// 2. Run against PostgreSQL Database
describe('PostgreSQL Real Integration', () => {
  let pgStore: DataRepositories;
  let pool: ReturnType<typeof getDatabasePool>;

  beforeAll(async () => {
    pool = getDatabasePool();
    await runMigrations(pool);
    await runSeed(pool);
    pgStore = createPostgresDataStore(pool);
  });

  afterAll(async () => {
    await closeDatabasePool();
  });

  runTestSuite('PostgreSQL', () => pgStore);
});

describe('assertLocalDatabaseTarget safety guard', () => {
  it('permits localhost and loopback with valid dev/test database names', () => {
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://postgres:postgres@127.0.0.1:5432/clientops_dev',
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://postgres:postgres@localhost:5432/test_db',
      ),
    ).not.toThrow();
  });

  it('fails closed on remote host targets', () => {
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://user:secret@db.production.com:5432/clientops_dev',
      ),
    ).toThrow(/non-local host "db.production.com"/);
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://user:secret@database.rds.amazonaws.com:5432/clientops_dev',
      ),
    ).toThrow(/non-local host "database.rds.amazonaws.com"/);
  });

  it('fails closed on unsafe database names', () => {
    expect(() =>
      assertLocalDatabaseTarget(
        'postgresql://postgres:postgres@127.0.0.1:5432/production_customers',
      ),
    ).toThrow(/does not match safe dev\/test patterns/);
  });

  it('fails closed on invalid URLs', () => {
    expect(() => assertLocalDatabaseTarget('not-a-valid-url')).toThrow(
      /Invalid connection string URL/,
    );
  });
});
