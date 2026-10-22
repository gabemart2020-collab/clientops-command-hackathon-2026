import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeterministicDemoOrchestrator } from './lib/orchestrator.js';

let server: http.Server;
let serverUrl: string;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};

      // Handle MCP initialization
      if (data.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'mock-session-123',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: data.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
            },
          }),
        );
        return;
      }

      if (data.method === 'notifications/initialized') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0' }));
        return;
      }

      // Handle tool calls
      if (data.method === 'tools/call') {
        const toolName = data.params?.name;
        const toolArgs = data.params?.arguments;

        if (toolName === 'account.get_context') {
          if (toolArgs?.account_ref === 'Nonexistent Client XYZ') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: data.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: 'Client "Nonexistent Client XYZ" not found.',
                    },
                  ],
                },
              }),
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: data.id,
              result: {
                content: [
                  { type: 'text', text: 'Client context for Acme Labs' },
                ],
                structuredContent: {
                  client: {
                    id: 'c0000000-0000-4000-8000-000000000001',
                    name: 'Acme Labs',
                    slug: 'acme-labs',
                    industry: 'Enterprise Biotechnology',
                    tier: 'enterprise',
                    createdAt: '2026-09-01T00:00:00.000Z',
                  },
                  activeProjects: [
                    {
                      id: 'a0000000-0000-4000-8000-000000000001',
                      name: 'Cloud Analytics Migration',
                      status: 'active',
                    },
                  ],
                  upcomingMeetings: [
                    {
                      id: 'e0000000-0000-4000-8000-000000000001',
                      title: 'Executive Review',
                      scheduledAt: '2026-10-16T14:00:00.000Z',
                      status: 'scheduled',
                    },
                  ],
                  counts: {
                    openTasks: 1,
                    completedTasks: 3,
                    openMilestones: 2,
                    overdueMilestones: 1,
                    openCommitments: 1,
                  },
                  openCommitments: [
                    {
                      id: 'c1000000-0000-4000-8000-000000000002',
                      clientId: 'c0000000-0000-4000-8000-000000000001',
                      description: 'Provide updated cutover rollback runbook',
                      owner: {
                        id: '10000000-0000-4000-8000-000000000012',
                        name: 'Bob Vance',
                        email: 'bob.vance@clientops-demo.internal',
                      },
                      dueAt: '2026-10-18T17:00:00.000Z',
                      status: 'open',
                    },
                  ],
                },
              },
            }),
          );
          return;
        }

        if (toolName === 'meeting.prepare_brief') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: data.id,
              result: {
                content: [
                  { type: 'text', text: 'Prepared brief for Executive Review' },
                ],
                structuredContent: {
                  meeting: {
                    id: 'e0000000-0000-4000-8000-000000000001',
                    title: 'Executive Review',
                    scheduledAt: '2026-10-16T14:00:00.000Z',
                    status: 'scheduled',
                  },
                  client: {
                    id: 'c0000000-0000-4000-8000-000000000001',
                    name: 'Acme Labs',
                    slug: 'acme-labs',
                    industry: 'Enterprise Biotechnology',
                    tier: 'enterprise',
                    createdAt: '2026-09-01T00:00:00.000Z',
                  },
                  projectStatus: {
                    projectId: 'a0000000-0000-4000-8000-000000000001',
                    clientId: 'c0000000-0000-4000-8000-000000000001',
                    health: 'at_risk',
                    findings: [
                      {
                        id: 'finding-1',
                        category: 'milestone_overdue',
                        severity: 'critical',
                        title: 'Overdue Milestone: Production Data Migration',
                        description:
                          'Milestone "Production Data Migration" was due on 2026-10-13T09:00:00.000Z.',
                        evidence: {
                          entityType: 'milestone',
                          entityId: 'b0000000-0000-4000-8000-000000000002',
                          field: 'due_at',
                          excerpt:
                            'Production Data Migration due 2026-10-13T09:00:00.000Z',
                        },
                      },
                    ],
                    evidence: [
                      {
                        entityType: 'milestone',
                        entityId: 'b0000000-0000-4000-8000-000000000002',
                      },
                    ],
                    evaluatedAt: '2026-10-15T09:00:00.000Z',
                  },
                  recentActivity: [
                    {
                      id: 'd0000000-0000-4000-8000-000000000001',
                      type: 'task_completed',
                      title: 'Configure IAM sync policies',
                      summary:
                        'Task "Configure IAM sync policies" was completed.',
                      occurredAt: '2026-10-12T16:00:00.000Z',
                      evidenceRef: {
                        entityType: 'task',
                        entityId: 'd0000000-0000-4000-8000-000000000001',
                      },
                    },
                  ],
                  openCommitments: [
                    {
                      id: 'c1000000-0000-4000-8000-000000000002',
                      clientId: 'c0000000-0000-4000-8000-000000000001',
                      description: 'Provide updated cutover rollback runbook',
                      owner: {
                        id: '10000000-0000-4000-8000-000000000012',
                        name: 'Bob Vance',
                        email: 'bob.vance@clientops-demo.internal',
                      },
                      dueAt: '2026-10-18T17:00:00.000Z',
                      status: 'open',
                    },
                  ],
                  riskFindings: [
                    {
                      id: 'finding-1',
                      category: 'milestone_overdue',
                      severity: 'critical',
                      title: 'Overdue Milestone: Production Data Migration',
                      description:
                        'Milestone "Production Data Migration" was due on 2026-10-13T09:00:00.000Z.',
                      evidence: {
                        entityType: 'milestone',
                        entityId: 'b0000000-0000-4000-8000-000000000002',
                        field: 'due_at',
                        excerpt:
                          'Production Data Migration due 2026-10-13T09:00:00.000Z',
                      },
                    },
                  ],
                  talkingPoints: [
                    'Project Cloud Analytics Migration delivery status is AT RISK.',
                    'Production Data Migration is overdue by 2 day(s).',
                  ],
                  evidence: [
                    {
                      entityType: 'milestone',
                      entityId: 'b0000000-0000-4000-8000-000000000002',
                    },
                  ],
                },
              },
            }),
          );
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      serverUrl = `http://127.0.0.1:${address.port}/mcp`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('apps/web: DeterministicDemoOrchestrator', () => {
  it('executes end-to-end hero workflow through official MCP client over Streamable HTTP', async () => {
    const orchestrator = new DeterministicDemoOrchestrator(serverUrl);
    const result = await orchestrator.runHeroWorkflow('Acme Labs');

    // 1. Account Context verification
    expect(result.clientContext.client.name).toBe('Acme Labs');
    expect(result.clientContext.client.id).toBe(
      'c0000000-0000-4000-8000-000000000001',
    );

    // 2. Brief & Health verification
    expect(result.brief.meeting.title).toBe('Executive Review');
    expect(result.brief.projectStatus?.health).toBe('at_risk');

    // 3. Evidence-backed Risk Findings
    expect(result.brief.riskFindings.length).toBe(1);
    const milestoneFinding = result.brief.riskFindings[0];
    expect(milestoneFinding?.category).toBe('milestone_overdue');
    expect(milestoneFinding?.evidence.entityType).toBe('milestone');
    expect(milestoneFinding?.evidence.entityId).toBe(
      'b0000000-0000-4000-8000-000000000002',
    );

    // 4. Open commitments and activity
    expect(result.brief.openCommitments.length).toBe(1);
    expect(result.brief.openCommitments[0]?.description).toBe(
      'Provide updated cutover rollback runbook',
    );
    expect(result.brief.recentActivity.length).toBe(1);

    // 5. Talking points
    expect(result.brief.talkingPoints.length).toBe(2);

    // 6. Trace verification
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]?.tool).toBe('account.get_context');
    expect(result.trace[0]?.status).toBe('ok');
    expect(result.trace[1]?.tool).toBe('meeting.prepare_brief');
    expect(result.trace[1]?.status).toBe('ok');
  });

  it('fails gracefully when MCP server is unavailable', async () => {
    const unreachableUrl = 'http://127.0.0.1:59999/mcp';
    const orchestrator = new DeterministicDemoOrchestrator(unreachableUrl);

    await expect(orchestrator.runHeroWorkflow('Acme Labs')).rejects.toThrow(
      /MCP_UNAVAILABLE/,
    );
  });

  it('fails with descriptive error when account is not found', async () => {
    const orchestrator = new DeterministicDemoOrchestrator(serverUrl);

    await expect(
      orchestrator.runHeroWorkflow('Nonexistent Client XYZ'),
    ).rejects.toThrow(/ACCOUNT_RESOLUTION_FAILED/);
  });
});
