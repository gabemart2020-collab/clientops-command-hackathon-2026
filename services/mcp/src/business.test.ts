import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  DEMO_ORGANIZATION_ID,
  createTenantContext,
  ClientOpsService,
  DemoScenarioClock,
} from '@clientops/domain';
import { createInMemoryDataStore } from '@clientops/data';
import {
  GetAccountContextOutputSchema,
  RecentActivityOutputSchema,
  ListOpenCommitmentsOutputSchema,
  AssessDeliveryHealthOutputSchema,
  PrepareBriefOutputSchema,
  TOOL_NAMES,
} from '@clientops/contracts';
import { readConfig, MCP_PROTOCOL_BASELINE } from './config.js';
import { startClientOpsService } from './index.js';
import { STATUS_TOOL } from './protocol.js';

let service: Awaited<ReturnType<typeof startClientOpsService>>;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeAll(async () => {
  const tenant = createTenantContext(DEMO_ORGANIZATION_ID);
  const dataStore = createInMemoryDataStore();
  const domainService = new ClientOpsService(
    dataStore,
    new DemoScenarioClock(),
  );

  service = await startClientOpsService(
    readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
    tenant,
    domainService,
  );

  transport = new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`));
  client = new Client(
    { name: 'business-tools-test-client', version: '1.0.0' },
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
});

describe('MCP ClientOps Business Tools over Streamable HTTP', () => {
  it('discovers all 6 registered tools (1 system + 5 business)', async () => {
    const discovery = await client.listTools();
    const toolNames = discovery.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(
      [
        STATUS_TOOL,
        TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        TOOL_NAMES.ACTIVITY_GET_RECENT,
        TOOL_NAMES.COMMITMENT_LIST_OPEN,
        TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
        TOOL_NAMES.MEETING_PREPARE_BRIEF,
      ].sort(),
    );
  });

  it('43. strictly exposes ZERO write or approval MCP tools in discovery', async () => {
    const discovery = await client.listTools();
    const names = discovery.tools.map((t) => t.name.toLowerCase());
    for (const name of names) {
      expect(name).not.toContain('create');
      expect(name).not.toContain('approve');
      expect(name).not.toContain('deny');
      expect(name).not.toContain('write');
      expect(name).not.toContain('mutate');
      expect(name).not.toContain('delete');
    }
    expect(names).not.toContain('task.create');
    expect(names).not.toContain('action.approve');
    expect(names).not.toContain('action.decide');
  });

  describe('account.get_context', () => {
    it('returns structured client context for Acme Labs', async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        arguments: { account_ref: 'Acme Labs' },
      });

      expect(result.isError).not.toBe(true);
      const parsed = GetAccountContextOutputSchema.parse(
        result.structuredContent,
      );
      expect(parsed.client.name).toBe('Acme Labs');
      expect(parsed.client.id).toBe('c0000000-0000-4000-8000-000000000001');
      expect(parsed.activeProjects).toHaveLength(1);
      expect(parsed.activeProjects[0]?.name).toBe('Cloud Analytics Migration');
      expect(parsed.upcomingMeetings.length).toBeGreaterThanOrEqual(1);
      expect(parsed.counts.openCommitments).toBe(1);
      expect(parsed.openCommitments).toHaveLength(1);
    });

    it('returns error when account_ref is not found', async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
        arguments: { account_ref: 'Nonexistent Client Corp' },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('not found');
    });
  });

  describe('activity.get_recent', () => {
    it('returns normalized activity within the lookback window', async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.ACTIVITY_GET_RECENT,
        arguments: {
          client_id: 'c0000000-0000-4000-8000-000000000001',
          lookback_days: 14,
        },
      });

      expect(result.isError).not.toBe(true);
      const parsed = RecentActivityOutputSchema.parse(result.structuredContent);
      expect(parsed.clientId).toBe('c0000000-0000-4000-8000-000000000001');
      expect(parsed.items.length).toBeGreaterThanOrEqual(5);

      // Verify stable sorting: descending by occurredAt
      for (let i = 0; i < parsed.items.length - 1; i++) {
        const curr = new Date(parsed.items[i]!.occurredAt).getTime();
        const next = new Date(parsed.items[i + 1]!.occurredAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(next);
      }

      // Verify all items contain evidence references
      for (const item of parsed.items) {
        expect(item.evidenceRef.entityType).toBeDefined();
        expect(item.evidenceRef.entityId).toBeDefined();
      }
    });
  });

  describe('commitment.list_open', () => {
    it('returns only open commitments for the client', async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.COMMITMENT_LIST_OPEN,
        arguments: { client_id: 'c0000000-0000-4000-8000-000000000001' },
      });

      expect(result.isError).not.toBe(true);
      const parsed = ListOpenCommitmentsOutputSchema.parse(
        result.structuredContent,
      );
      expect(parsed.commitments).toHaveLength(1);
      expect(parsed.commitments[0]?.status).toBe('open');
      expect(parsed.commitments[0]?.description).toBe(
        'Provide updated cutover rollback runbook',
      );
      expect(parsed.commitments[0]?.owner.name).toBe('Bob Vance');
    });
  });

  describe('project.assess_delivery_health', () => {
    it('deterministically evaluates Acme project health as at_risk with required evidence', async () => {
      const projectId = 'a0000000-0000-4000-8000-000000000001';
      const result = await client.callTool({
        name: TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
        arguments: { project_id: projectId },
      });

      expect(result.isError).not.toBe(true);
      const parsed = AssessDeliveryHealthOutputSchema.parse(
        result.structuredContent,
      );

      // Aggregate health must evaluate strictly to at_risk
      expect(parsed.health).toBe('at_risk');

      // 1. Must include overdue migration milestone finding
      const milestoneFinding = parsed.findings.find(
        (f) => f.category === 'milestone_overdue',
      );
      expect(milestoneFinding).toBeDefined();
      expect(milestoneFinding?.title).toContain('Production Data Migration');
      expect(milestoneFinding?.evidence.entityType).toBe('milestone');
      expect(milestoneFinding?.evidence.entityId).toBe(
        'b0000000-0000-4000-8000-000000000002',
      );

      // 2. Must include unresolved analytics question finding
      const questionFinding = parsed.findings.find(
        (f) => f.category === 'unresolved_question',
      );
      expect(questionFinding).toBeDefined();
      expect(questionFinding?.title).toContain(
        'Discrepancy in Q3 Analytics Export',
      );
      expect(questionFinding?.evidence.entityType).toBe('communication');
      expect(questionFinding?.evidence.entityId).toBe(
        'f0000000-0000-4000-8000-000000000001',
      );

      // Verify evidence array contains references
      expect(parsed.evidence.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('meeting.prepare_brief', () => {
    it('composes a deterministic structured brief for Executive Review tomorrow', async () => {
      const meetingId = 'e0000000-0000-4000-8000-000000000001';
      const result = await client.callTool({
        name: TOOL_NAMES.MEETING_PREPARE_BRIEF,
        arguments: { meeting_id: meetingId },
      });

      expect(result.isError).not.toBe(true);
      const brief = PrepareBriefOutputSchema.parse(result.structuredContent);

      expect(brief.meeting.title).toBe('Executive Review');
      expect(brief.meeting.scheduledAt).toBe('2026-10-16T14:00:00.000Z');
      expect(brief.client.name).toBe('Acme Labs');
      expect(brief.projectStatus?.health).toBe('at_risk');
      expect(brief.openCommitments).toHaveLength(1);
      expect(brief.riskFindings.length).toBeGreaterThanOrEqual(2);

      // Talking points must be factual statements derived from data
      expect(
        brief.talkingPoints.some((p) =>
          p.includes('Executive review meeting scheduled for tomorrow'),
        ),
      ).toBe(true);
      expect(brief.talkingPoints.some((p) => p.includes('AT RISK'))).toBe(true);
      expect(
        brief.talkingPoints.some((p) =>
          p.includes('Production Data Migration'),
        ),
      ).toBe(true);

      // Evidence list is populated
      expect(brief.evidence.length).toBeGreaterThanOrEqual(2);
    });
  });
});
