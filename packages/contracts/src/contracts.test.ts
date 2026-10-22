import { describe, expect, it } from 'vitest';
import {
  EvidenceRefSchema,
  CommitmentSchema,
  RecentActivityInputSchema,
  AssessDeliveryHealthOutputSchema,
  AgentBriefFindingSchema,
  AgentBriefSchema,
  AgentModelOutputSchema,
  CLIENTOPS_TOOL_DEFINITIONS,
  TOOL_NAMES,
} from './index.js';

describe('packages/contracts schemas', () => {
  it('validates a correct EvidenceRef', () => {
    const valid = {
      entityType: 'milestone',
      entityId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      field: 'due_at',
      excerpt: 'Due 2 days ago',
    };
    expect(EvidenceRefSchema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid EvidenceRef with unknown entityType or invalid UUID', () => {
    expect(() =>
      EvidenceRefSchema.parse({
        entityType: 'unknown_type',
        entityId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('validates RecentActivityInput bounds', () => {
    const valid = {
      client_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      lookback_days: 30,
    };
    expect(RecentActivityInputSchema.parse(valid)).toEqual(valid);

    // Default lookback_days
    expect(
      RecentActivityInputSchema.parse({
        client_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).toEqual({
      client_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      lookback_days: 14,
    });

    // Out of bounds
    expect(() =>
      RecentActivityInputSchema.parse({
        client_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        lookback_days: 0,
      }),
    ).toThrow();
    expect(() =>
      RecentActivityInputSchema.parse({
        client_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        lookback_days: 100,
      }),
    ).toThrow();
  });

  it('validates CommitmentSchema with owner and evidence', () => {
    const valid = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      clientId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      description: 'Provide updated runbook',
      owner: {
        id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
        name: 'Alice Walker',
        email: 'alice@example.com',
      },
      dueAt: '2026-10-18T17:00:00.000Z',
      status: 'open',
    };
    expect(CommitmentSchema.parse(valid)).toEqual(valid);
  });

  it('validates AssessDeliveryHealthOutputSchema', () => {
    const valid = {
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      clientId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      health: 'at_risk',
      findings: [
        {
          id: 'risk-1',
          category: 'milestone_overdue',
          severity: 'high',
          title: 'Milestone overdue',
          description: 'Production migration is 2 days overdue',
          evidence: {
            entityType: 'milestone',
            entityId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
            field: 'due_at',
          },
        },
      ],
      evidence: [
        {
          entityType: 'milestone',
          entityId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
          field: 'due_at',
        },
      ],
      evaluatedAt: '2026-10-15T09:00:00.000Z',
    };
    expect(AssessDeliveryHealthOutputSchema.parse(valid)).toEqual(valid);
  });

  it('contains definitions for exactly all 5 Phase 2 tools with READ or ANALYZE classifications', () => {
    const tools = Object.values(CLIENTOPS_TOOL_DEFINITIONS);
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(['READ', 'ANALYZE']).toContain(tool.classification);
      expect(tool.readOnly).toBe(true);
      expect(tool.idempotent).toBe(true);
    }
    expect(
      CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.ACCOUNT_GET_CONTEXT].classification,
    ).toBe('READ');
    expect(
      CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH]
        .classification,
    ).toBe('ANALYZE');
    expect(
      CLIENTOPS_TOOL_DEFINITIONS[TOOL_NAMES.MEETING_PREPARE_BRIEF]
        .classification,
    ).toBe('ANALYZE');
  });

  it('validates AgentBriefFindingSchema with evidence', () => {
    const valid = {
      statement: 'Milestone is overdue',
      evidence: [
        {
          entityType: 'milestone',
          entityId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          field: 'due_at',
          excerpt: 'Due 2 days ago',
        },
      ],
    };
    expect(AgentBriefFindingSchema.parse(valid)).toEqual(valid);
  });

  it('rejects AgentBriefFindingSchema with empty evidence', () => {
    const invalid = {
      statement: 'Milestone is overdue with zero evidence',
      evidence: [],
    };
    expect(() => AgentBriefFindingSchema.parse(invalid)).toThrow(
      /A finding must include at least one evidence reference/,
    );
  });

  it('validates AgentBriefSchema structure', () => {
    const brief = {
      answer: 'Client status summary',
      account: {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        name: 'Acme Labs',
      },
      health: 'at_risk',
      findings: [
        {
          statement: 'Milestone is overdue',
          evidence: [
            {
              entityType: 'milestone',
              entityId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
            },
          ],
        },
      ],
      suggestedNextSteps: ['Escalate milestone'],
    };
    expect(AgentBriefSchema.parse(brief)).toEqual({
      ...brief,
      mode: 'operational',
    });
  });

  it('validates AgentBriefSchema with capability_refusal mode and empty findings', () => {
    const refusal = {
      mode: 'capability_refusal' as const,
      refusalReason: 'ClientOps is read-only and cannot create tasks.',
      answer:
        'I cannot create a task for the migration because I am a read-only operations agent.',
      findings: [],
      suggestedNextSteps: ['Manually create task in project tracker'],
    };
    expect(AgentBriefSchema.parse(refusal)).toEqual(refusal);
  });

  describe('AgentBriefSchema and AgentModelOutputSchema mode invariants', () => {
    const validProposedAction = {
      actionType: 'task.create' as const,
      parameters: {
        clientId: 'c0000000-0000-4000-8000-000000000001',
        projectId: 'a0000000-0000-4000-8000-000000000001',
        title: 'Run production migration test',
      },
      justification:
        'Critical migration requires executive incident follow-up.',
      citations: [
        {
          entityType: 'milestone' as const,
          entityId: 'b0000000-0000-4000-8000-000000000001',
          field: 'due_at',
        },
      ],
    };

    it('operational mode rejects presence of proposedAction', () => {
      const briefWithAction = {
        mode: 'operational' as const,
        answer: 'Here is your operational update.',
        findings: [],
        suggestedNextSteps: [],
        proposedAction: validProposedAction,
      };

      const result = AgentBriefSchema.safeParse(briefWithAction);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /proposedAction must be absent in operational mode/,
        );
      }
    });

    it('capability_refusal mode rejects presence of proposedAction', () => {
      const refusalWithAction = {
        mode: 'capability_refusal' as const,
        refusalReason: 'Read only agent.',
        answer: 'I cannot execute this mutation.',
        findings: [],
        suggestedNextSteps: [],
        proposedAction: validProposedAction,
      };

      const result = AgentBriefSchema.safeParse(refusalWithAction);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /proposedAction must be absent in capability_refusal mode/,
        );
      }
    });

    it('action_proposal mode rejects missing proposedAction', () => {
      const proposalWithoutAction = {
        mode: 'action_proposal' as const,
        answer:
          'The task has not been created. Human approval is required from an operator.',
        findings: [],
        suggestedNextSteps: [],
      };

      const result = AgentBriefSchema.safeParse(proposalWithoutAction);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /proposedAction is required in action_proposal mode/,
        );
      }
    });

    it('action_proposal mode rejects unsupported actionType', () => {
      const proposalWithBadType = {
        mode: 'action_proposal' as const,
        answer: 'The task was not created. Awaiting human operator approval.',
        findings: [],
        suggestedNextSteps: [],
        proposedAction: {
          ...validProposedAction,
          actionType: 'task.update' as unknown as 'task.create',
        },
      };

      const result = AgentBriefSchema.safeParse(proposalWithBadType);
      expect(result.success).toBe(false);
    });

    it('action_proposal mode rejects answer that does not state task was not created/executed', () => {
      const proposalWithoutNonExecution = {
        mode: 'action_proposal' as const,
        answer:
          'I proposed creating this task. Human operator approval is required.',
        findings: [],
        suggestedNextSteps: [],
        proposedAction: validProposedAction,
      };

      const result = AgentBriefSchema.safeParse(proposalWithoutNonExecution);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) =>
            i.message.includes('NOT created or executed'),
          ),
        ).toBe(true);
      }
    });

    it('action_proposal mode rejects answer that does not mention required human approval', () => {
      const proposalWithoutApproval = {
        mode: 'action_proposal' as const,
        answer: 'The task has not been created or executed yet.',
        findings: [],
        suggestedNextSteps: [],
        proposedAction: validProposedAction,
      };

      const result = AgentBriefSchema.safeParse(proposalWithoutApproval);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) =>
            i.message.includes('human approval is required'),
          ),
        ).toBe(true);
      }
    });

    it('action_proposal mode accepts fully compliant brief and preserves schema shape', () => {
      const compliant = {
        mode: 'action_proposal' as const,
        answer:
          'The proposed task was not created or executed. Human approval from an authorized operator is required.',
        findings: [],
        suggestedNextSteps: ['Review and approve the task proposal'],
        proposedAction: validProposedAction,
      };

      const parsed = AgentBriefSchema.parse(compliant);
      expect(parsed.mode).toBe('action_proposal');
      expect(parsed.proposedAction?.actionType).toBe('task.create');

      // Verify shape property is preserved for Strands schema generator
      expect(AgentBriefSchema.shape).toBeDefined();
      expect(AgentBriefSchema.shape.mode).toBeDefined();
      expect(AgentBriefSchema.shape.proposedAction).toBeDefined();

      expect(AgentModelOutputSchema.shape).toBeDefined();
      expect(AgentModelOutputSchema.shape.health).toBeDefined();
    });
  });
});
