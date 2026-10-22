import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createTenantContext,
  DEMO_ORGANIZATION_ID,
  ClientOpsService,
  DemoScenarioClock,
  SECOND_TEST_ORGANIZATION_ID,
} from '@clientops/domain';
import {
  createInMemoryDataStore,
  createPostgresDataStore,
  getDatabasePool,
  closeDatabasePool,
  runMigrations,
  runSeed,
} from '@clientops/data';
import {
  EvidenceRefSchema,
  GetAccountContextOutputSchema,
  PrepareBriefOutputSchema,
  TOOL_NAMES,
} from '@clientops/contracts';
import {
  startClientOpsService,
  readConfig,
  MCP_PROTOCOL_BASELINE,
} from '../services/mcp/src/index.js';

describe.each([
  {
    datastoreName: 'InMemoryDataStore',
    factory: () => createInMemoryDataStore(),
  },
  {
    datastoreName: 'PostgresDataStore',
    factory: () => createPostgresDataStore(getDatabasePool()),
  },
])(
  'Hero Scenario End-to-End ($datastoreName)',
  ({ datastoreName, factory }) => {
    let service: Awaited<ReturnType<typeof startClientOpsService>>;
    let client: Client;
    let transport: StreamableHTTPClientTransport;

    beforeAll(async () => {
      if (datastoreName === 'PostgresDataStore') {
        const pool = getDatabasePool();
        await runMigrations(pool);
        await runSeed(pool);
      }

      const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
      const dataStore = factory();
      const clock = new DemoScenarioClock();
      const domainService = new ClientOpsService(dataStore, clock);

      service = await startClientOpsService(
        readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
        tenant,
        domainService,
      );

      transport = new StreamableHTTPClientTransport(
        new URL(`${service.url}/mcp`),
      );
      client = new Client(
        { name: 'hero-test-client', version: '1.0.0' },
        {
          supportedProtocolVersions: [MCP_PROTOCOL_BASELINE],
          versionNegotiation: { mode: 'legacy' },
        },
      );
      await client.connect(transport);
    });

    afterAll(async () => {
      await client?.close();
      await service?.close();
      await closeDatabasePool();
    });

    it('proves the full Acme Labs vertical slice with deterministic rules and evidence references', async () => {
      // Step 1: Query account context via official MCP client
      const accountContextRes = await client.callTool({
        name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        arguments: { account_ref: 'Acme Labs' },
      });

      expect(accountContextRes.isError).not.toBe(true);
      const accountContext = GetAccountContextOutputSchema.parse(
        accountContextRes.structuredContent,
      );

      // 1. Target client verification
      expect(accountContext.client.name).toBe('Acme Labs');
      expect(accountContext.client.id).toBe(
        'c0000000-0000-4000-8000-000000000001',
      );
      expect(accountContext.client.tier).toBe('enterprise');

      // 2. Locate the target upcoming Executive Review meeting (tomorrow relative to demo clock 2026-10-15T09:00:00Z)
      const reviewMeeting = accountContext.upcomingMeetings.find(
        (m) => m.title === 'Executive Review',
      );
      expect(reviewMeeting).toBeDefined();
      expect(reviewMeeting?.scheduledAt).toBe('2026-10-16T14:00:00.000Z');

      // Step 2: Prepare review brief via official MCP client
      const briefRes = await client.callTool({
        name: TOOL_NAMES.MEETING_PREPARE_BRIEF,
        arguments: { meeting_id: reviewMeeting!.id },
      });

      expect(briefRes.isError).not.toBe(true);
      const brief = PrepareBriefOutputSchema.parse(briefRes.structuredContent);

      // 3. Evaluated delivery health: AT RISK
      expect(brief.projectStatus).toBeDefined();
      expect(brief.projectStatus?.health).toBe('at_risk');

      // 4. Risk finding 1: Production Data Migration milestone overdue (due 2026-10-13, 2 days overdue)
      const milestoneFinding = brief.riskFindings.find(
        (f) => f.category === 'milestone_overdue',
      );
      expect(milestoneFinding).toBeDefined();
      expect(milestoneFinding?.severity).toBe('high');
      expect(milestoneFinding?.title).toContain('Production Data Migration');
      expect(milestoneFinding?.description).toContain(
        '2026-10-13T09:00:00.000Z',
      );
      expect(milestoneFinding?.description).toContain('2 days past target');
      expect(milestoneFinding?.evidence.entityType).toBe('milestone');
      expect(milestoneFinding?.evidence.entityId).toBe(
        'b0000000-0000-4000-8000-000000000002',
      );
      expect(milestoneFinding?.evidence.field).toBe('due_at');
      expect(milestoneFinding?.evidence.excerpt).toContain(
        'is 2 day(s) overdue',
      );

      // 5. Risk finding 2: Discrepancy in Q3 Analytics Export unresolved client question
      const questionFinding = brief.riskFindings.find(
        (f) => f.category === 'unresolved_question',
      );
      expect(questionFinding).toBeDefined();
      expect(questionFinding?.severity).toBe('high');
      expect(questionFinding?.title).toContain(
        'Discrepancy in Q3 Analytics Export',
      );
      expect(questionFinding?.evidence.entityType).toBe('communication');
      expect(questionFinding?.evidence.entityId).toBe(
        'f0000000-0000-4000-8000-000000000001',
      );
      expect(questionFinding?.evidence.field).toBe('requires_response');
      expect(questionFinding?.evidence.excerpt).toBeDefined();

      // 6. All risk findings must carry non-null, valid EvidenceRef structures
      for (const finding of brief.riskFindings) {
        expect(finding.evidence).toBeDefined();
        expect(finding.evidence).not.toBeNull();
        const parsedEvidence = EvidenceRefSchema.safeParse(finding.evidence);
        expect(parsedEvidence.success).toBe(true);
        expect(finding.evidence.entityId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      }

      // 7. Open commitments list includes 'Provide updated cutover rollback runbook' and excludes fulfilled commitments
      expect(brief.openCommitments).toHaveLength(1);
      expect(brief.openCommitments[0]?.description).toBe(
        'Provide updated cutover rollback runbook',
      );
      expect(brief.openCommitments[0]?.status).toBe('open');
      const fulfilledFound = brief.openCommitments.some(
        (c) => c.description === 'Deliver revised schema documentation',
      );
      expect(fulfilledFound).toBe(false);

      // 8. Talking points contain factual statements reflecting these facts
      expect(brief.talkingPoints.length).toBeGreaterThanOrEqual(3);
      const hasAtRiskPoint = brief.talkingPoints.some((p) =>
        p.includes('AT RISK'),
      );
      const hasOverdueMilestonePoint = brief.talkingPoints.some(
        (p) =>
          p.includes('Production Data Migration') &&
          p.toLowerCase().includes('overdue'),
      );
      const hasOpenQuestionPoint = brief.talkingPoints.some((p) =>
        p.includes('Discrepancy in Q3 Analytics Export'),
      );
      expect(hasAtRiskPoint).toBe(true);
      expect(hasOverdueMilestonePoint).toBe(true);
      expect(hasOpenQuestionPoint).toBe(true);
    });

    it('guarantees tenant isolation: BetaCorp tenant context cannot access Acme Labs Org 1 data', async () => {
      // Instantiate service bound to Tenant 2 (BetaCorp)
      const org2Tenant = createTenantContext(SECOND_TEST_ORGANIZATION_ID);
      const org2DataStore = factory();
      const clock = new DemoScenarioClock();
      const org2DomainService = new ClientOpsService(org2DataStore, clock);

      const org2Service = await startClientOpsService(
        readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
        org2Tenant,
        org2DomainService,
      );

      const org2Transport = new StreamableHTTPClientTransport(
        new URL(`${org2Service.url}/mcp`),
      );
      const org2Client = new Client(
        { name: 'tenant2-test-client', version: '1.0.0' },
        {
          supportedProtocolVersions: [MCP_PROTOCOL_BASELINE],
          versionNegotiation: { mode: 'legacy' },
        },
      );
      await org2Client.connect(org2Transport);

      try {
        // Query Acme Labs under Tenant 2
        const org2AcmeRes = await org2Client.callTool({
          name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
          arguments: { account_ref: 'Acme Labs' },
        });

        expect(org2AcmeRes.isError).not.toBe(true);
        const parsed = GetAccountContextOutputSchema.parse(
          org2AcmeRes.structuredContent,
        );

        // Must be Org 2's Acme Labs record, never Org 1's
        expect(parsed.client.id).toBe('c0000000-0000-4000-8000-000000000021');
        expect(parsed.client.industry).toBe('Manufacturing'); // Org 2's industry, not Biotechnology
        expect(parsed.activeProjects).toHaveLength(1);
        expect(parsed.activeProjects[0]?.name).toBe(
          'BetaCorp Pilot Integration',
        );
      } finally {
        await org2Client.close();
        await org2Service.close();
      }
    });
  },
);
