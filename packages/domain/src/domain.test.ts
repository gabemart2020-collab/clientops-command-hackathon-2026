import { describe, expect, it } from 'vitest';
import {
  DemoScenarioClock,
  FixedClock,
  SystemClock,
  DEMO_SCENARIO_TIMESTAMP,
  createTenantContext,
  evaluateDeliveryHealth,
  deriveTalkingPoints,
  type MilestoneEntity,
  type TaskEntity,
  type CommunicationEntity,
  type MeetingEntity,
} from './index.js';

describe('packages/domain', () => {
  describe('Clock abstraction', () => {
    it('SystemClock returns a current date', () => {
      const clock = new SystemClock();
      const before = Date.now();
      const now = clock.now().getTime();
      const after = Date.now();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });

    it('FixedClock returns the exact fixed timestamp deterministically', () => {
      const fixedIso = '2026-10-15T09:00:00.000Z';
      const clock = new FixedClock(fixedIso);
      expect(clock.now().toISOString()).toBe(fixedIso);
      expect(clock.now().toISOString()).toBe(fixedIso);
    });

    it('DemoScenarioClock returns canonical 2026-10-15T09:00:00.000Z', () => {
      const clock = new DemoScenarioClock();
      expect(clock.now().toISOString()).toBe(DEMO_SCENARIO_TIMESTAMP);
    });
  });

  describe('TenantContext', () => {
    it('creates valid tenant context for a valid UUID', () => {
      const id = '11111111-1111-1111-1111-111111111111';
      const context = createTenantContext(id);
      expect(context.organizationId).toBe(id);
    });

    it('throws for an invalid or missing organization ID', () => {
      expect(() => createTenantContext('not-a-uuid')).toThrow();
      expect(() => createTenantContext('')).toThrow();
    });
  });

  describe('Deterministic Delivery Health Rules', () => {
    const evalTime = new Date('2026-10-15T09:00:00.000Z');
    const projectId = 'p1111111-1111-1111-1111-111111111111';
    const clientId = 'c1111111-1111-1111-1111-111111111111';

    it('evaluates to on_track when all milestones, tasks, and comms are clear', () => {
      const result = evaluateDeliveryHealth({
        projectId,
        clientId,
        milestones: [
          {
            id: 'm1',
            organizationId: 'o1',
            projectId,
            title: 'Design Phase',
            status: 'completed',
            dueAt: '2026-10-01T00:00:00.000Z',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'm2',
            organizationId: 'o1',
            projectId,
            title: 'Future Milestone',
            status: 'open',
            dueAt: '2026-10-30T00:00:00.000Z',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        tasks: [],
        communications: [],
        commitments: [],
        evaluationTime: evalTime,
      });

      expect(result.health).toBe('on_track');
      expect(result.findings).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    });

    it('detects overdue milestone and unresolved question deterministically with at_risk health', () => {
      const overdueMilestone: MilestoneEntity = {
        id: 'm-overdue-1',
        organizationId: 'o1',
        projectId,
        title: 'Production Data Migration',
        status: 'open',
        dueAt: '2026-10-13T09:00:00.000Z', // Exactly 2 days before 2026-10-15T09:00:00.000Z
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      };

      const unresolvedQuestion: CommunicationEntity = {
        id: 'comm-q-1',
        organizationId: 'o1',
        clientId,
        channel: 'email',
        subject: 'Discrepancy in Q3 Analytics Export',
        summary:
          'Client team noticed export figures for Q3 do not reconcile with warehouse.',
        occurredAt: '2026-10-14T11:00:00.000Z',
        requiresResponse: true,
        resolvedAt: undefined,
        createdAt: '2026-10-14T11:00:00.000Z',
        updatedAt: '2026-10-14T11:00:00.000Z',
      };

      const result = evaluateDeliveryHealth({
        projectId,
        clientId,
        milestones: [overdueMilestone],
        tasks: [],
        communications: [unresolvedQuestion],
        commitments: [],
        evaluationTime: evalTime,
      });

      expect(result.health).toBe('at_risk');
      expect(result.findings).toHaveLength(2);

      const milestoneFinding = result.findings.find(
        (f) => f.category === 'milestone_overdue',
      );
      expect(milestoneFinding).toBeDefined();
      expect(milestoneFinding?.severity).toBe('high');
      expect(milestoneFinding?.description).toContain('2 days past target');
      expect(milestoneFinding?.evidence.excerpt).toContain(
        'is 2 day(s) overdue',
      );
      expect(milestoneFinding?.evidence).toMatchObject({
        entityType: 'milestone',
        entityId: overdueMilestone.id,
        field: 'due_at',
      });

      const questionFinding = result.findings.find(
        (f) => f.category === 'unresolved_question',
      );
      expect(questionFinding).toBeDefined();
      expect(questionFinding?.severity).toBe('high');
      expect(questionFinding?.evidence).toMatchObject({
        entityType: 'communication',
        entityId: unresolvedQuestion.id,
        field: 'requires_response',
      });
    });

    it('evaluates to watch when only overdue tasks exist (medium severity)', () => {
      const overdueTask: TaskEntity = {
        id: 't-overdue-1',
        organizationId: 'o1',
        projectId,
        title: 'Review staging logs',
        status: 'in_progress',
        dueAt: '2026-10-14T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      };

      const result = evaluateDeliveryHealth({
        projectId,
        clientId,
        milestones: [],
        tasks: [overdueTask],
        communications: [],
        commitments: [],
        evaluationTime: evalTime,
      });

      expect(result.health).toBe('watch');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.category).toBe('task_overdue');
    });
  });

  describe('Talking Points Derivation', () => {
    it('generates factual talking points without hallucinated prose', () => {
      const evalTime = new Date('2026-10-15T09:00:00.000Z');
      const meeting: MeetingEntity = {
        id: 'meet-1',
        organizationId: 'o1',
        clientId: 'c1',
        title: 'Executive Review',
        scheduledAt: '2026-10-16T14:00:00.000Z', // Tomorrow relative to 2026-10-15
        status: 'scheduled',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      };

      const points = deriveTalkingPoints({
        meeting,
        project: {
          id: 'p1',
          organizationId: 'o1',
          clientId: 'c1',
          name: 'Cloud Data Migration',
          status: 'active',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        healthResult: {
          projectId: 'p1',
          clientId: 'c1',
          health: 'at_risk',
          findings: [
            {
              id: 'f1',
              category: 'milestone_overdue',
              severity: 'high',
              title: 'Production Data Migration Overdue',
              description: '2 days overdue',
              evidence: {
                entityType: 'milestone',
                entityId: 'm1',
              },
            },
          ],
          evidence: [],
          evaluatedAt: evalTime.toISOString(),
        },
        openCommitments: [
          {
            id: 'c-1',
            organizationId: 'o1',
            clientId: 'c1',
            description: 'Provide cutover runbook',
            ownerUserId: 'u1',
            dueAt: '2026-10-18T17:00:00.000Z',
            status: 'open',
            createdAt: '2026-10-10T00:00:00.000Z',
            updatedAt: '2026-10-10T00:00:00.000Z',
          },
        ],
        completedTasksCount: 3,
        evaluationTime: evalTime,
      });

      expect(
        points.some((p) =>
          p.includes('Executive review meeting scheduled for tomorrow'),
        ),
      ).toBe(true);
      expect(points.some((p) => p.includes('AT RISK'))).toBe(true);
      expect(
        points.some((p) => p.includes('Production Data Migration Overdue')),
      ).toBe(true);
      expect(points.some((p) => p.includes('1 open commitment(s)'))).toBe(true);
      expect(
        points.some((p) => p.includes('3 task(s) recently completed')),
      ).toBe(true);
    });
  });
});
