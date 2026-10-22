import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_HTTP_CONTRACT,
  AGENT_RUNTIME_MODEL_TOOL_NAMES,
  AgentInvocationRequestV1Schema,
  AgentInvocationResponseV1Schema,
  AgentRuntimeCertificationIdentitySchema,
  PHASE5_2_CERTIFICATION_MODEL_ID,
} from './agent-runtime.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000011';
const proposalId = '33333333-3333-4333-8333-333333333333';

describe('Phase 5.2 Agent Runtime contracts', () => {
  it('freezes the Node 24 ARM64 HTTP and MCP protocol baselines', () => {
    expect(AGENT_RUNTIME_HTTP_CONTRACT).toEqual({
      protocol: 'HTTP',
      host: '0.0.0.0',
      port: 8080,
      invocationPath: '/invocations',
      pingPath: '/ping',
      architecture: 'linux/arm64',
      nodeMajor: 24,
      mcpProtocolVersion: '2025-11-25',
    });
    expect(PHASE5_2_CERTIFICATION_MODEL_ID).toBe(
      'us.anthropic.claude-sonnet-4-6',
    );
  });

  it('freezes exactly five model-facing READ/ANALYZE tool names', () => {
    expect(AGENT_RUNTIME_MODEL_TOOL_NAMES).toEqual([
      'account_get_context',
      'activity_get_recent',
      'commitment_list_open',
      'project_assess_delivery_health',
      'meeting_prepare_brief',
    ]);
    expect(AGENT_RUNTIME_MODEL_TOOL_NAMES).not.toContain(
      'system_get_status' as never,
    );
    expect(
      AGENT_RUNTIME_MODEL_TOOL_NAMES.some((name) =>
        /(create|approve|deny|execute|write|mutate|delete|send)/i.test(name),
      ),
    ).toBe(false);
  });

  it('requires strict server-derived invocation identity and bounded input', () => {
    const valid = {
      version: '1',
      requestId,
      sessionId,
      organizationId,
      actorId,
      userMessage: 'Prepare the Acme review brief.',
      accountHint: 'Acme Labs',
    };

    expect(AgentInvocationRequestV1Schema.parse(valid)).toEqual(valid);
    expect(() =>
      AgentInvocationRequestV1Schema.parse({
        ...valid,
        actorRole: 'admin',
      }),
    ).toThrow();
    expect(() =>
      AgentInvocationRequestV1Schema.parse({
        ...valid,
        userMessage: 'x'.repeat(8001),
      }),
    ).toThrow();
  });

  it('keeps the non-production certification identity narrow and non-authorizing', () => {
    expect(
      AgentRuntimeCertificationIdentitySchema.parse({
        organizationId,
        actorId,
      }),
    ).toEqual({ organizationId, actorId });

    expect(() =>
      AgentRuntimeCertificationIdentitySchema.parse({
        organizationId,
        actorId,
        role: 'admin',
      }),
    ).toThrow();
  });

  it('accepts a sanitized operational success response', () => {
    const response = {
      version: '1',
      requestId,
      success: true,
      data: {
        brief: {
          mode: 'operational',
          answer: 'Acme is at risk due to an overdue migration milestone.',
          findings: [],
          suggestedNextSteps: ['Review the overdue migration milestone.'],
        },
        toolTrace: [
          {
            toolName: 'project_assess_delivery_health',
            status: 'ok',
            durationMs: 18,
            evidenceCount: 2,
          },
        ],
        modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
        stopReason: 'end_turn',
        latencyMs: 750,
        grounding: {
          valid: true,
          unsupportedEvidenceCount: 0,
        },
      },
    };

    expect(AgentInvocationResponseV1Schema.parse(response)).toEqual(response);
  });

  it('permits proposal metadata only at PENDING_APPROVAL', () => {
    const base = {
      version: '1',
      requestId,
      success: true,
      data: {
        brief: {
          mode: 'action_proposal',
          answer:
            'The proposed task was not created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Review the task proposal.'],
          proposedAction: {
            actionType: 'task.create',
            parameters: {
              clientId: 'c0000000-0000-4000-8000-000000000001',
              projectId: 'a0000000-0000-4000-8000-000000000001',
              title: 'Prepare migration rollback runbook',
              priority: 'medium',
            },
            justification: 'The overdue migration requires a rollback runbook.',
            citations: [
              {
                entityType: 'project',
                entityId: 'a0000000-0000-4000-8000-000000000001',
                field: 'updated_at',
              },
            ],
          },
        },
        toolTrace: [],
        modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
        stopReason: 'end_turn',
        latencyMs: 900,
        grounding: {
          valid: true,
          unsupportedEvidenceCount: 0,
        },
        actionProposal: {
          proposalId,
          status: 'PENDING_APPROVAL',
          reviewUrl: `/actions/${proposalId}`,
        },
      },
    };

    expect(AgentInvocationResponseV1Schema.parse(base)).toEqual(base);
    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          actionProposal: {
            ...base.data.actionProposal,
            status: 'APPROVED',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects successful responses with unsupported grounding or model drift', () => {
    const base = {
      version: '1',
      requestId,
      success: true,
      data: {
        brief: {
          mode: 'operational',
          answer: 'Acme status summary.',
          findings: [],
          suggestedNextSteps: [],
        },
        toolTrace: [],
        modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
        stopReason: 'end_turn',
        latencyMs: 100,
        grounding: {
          valid: true,
          unsupportedEvidenceCount: 0,
        },
      },
    };

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          grounding: {
            valid: true,
            unsupportedEvidenceCount: 1,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          modelId: 'unexpected-model',
        },
      }),
    ).toThrow();
  });

  it('binds proposal metadata exactly to action_proposal brief mode', () => {
    const actionBrief = {
      mode: 'action_proposal' as const,
      answer:
        'The proposed task was not created or executed. Human approval from an authorized operator is required.',
      findings: [],
      suggestedNextSteps: ['Review the task proposal.'],
      proposedAction: {
        actionType: 'task.create' as const,
        parameters: {
          clientId: 'c0000000-0000-4000-8000-000000000001',
          projectId: 'a0000000-0000-4000-8000-000000000001',
          title: 'Prepare migration rollback runbook',
          priority: 'medium' as const,
        },
        justification: 'The overdue migration requires a rollback runbook.',
        citations: [
          {
            entityType: 'project' as const,
            entityId: 'a0000000-0000-4000-8000-000000000001',
            field: 'updated_at',
          },
        ],
      },
    };

    const common = {
      version: '1',
      requestId,
      success: true,
      data: {
        brief: actionBrief,
        toolTrace: [],
        modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
        stopReason: 'end_turn',
        latencyMs: 100,
        grounding: {
          valid: true,
          unsupportedEvidenceCount: 0,
        },
      },
    };

    expect(() => AgentInvocationResponseV1Schema.parse(common)).toThrow(
      /actionProposal is required/,
    );

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...common,
        data: {
          ...common.data,
          brief: {
            mode: 'operational',
            answer: 'Acme status summary.',
            findings: [],
            suggestedNextSteps: [],
          },
          actionProposal: {
            proposalId,
            status: 'PENDING_APPROVAL',
            reviewUrl: `/actions/${proposalId}`,
          },
        },
      }),
    ).toThrow(/actionProposal must be absent/);
  });

  it('rejects internal evidence, hashes, raw arguments, and unauthorized tool names', () => {
    const base = {
      version: '1',
      requestId,
      success: true,
      data: {
        brief: {
          mode: 'operational',
          answer: 'Acme status summary.',
          findings: [],
          suggestedNextSteps: [],
        },
        toolTrace: [],
        modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
        stopReason: 'end_turn',
        latencyMs: 100,
        grounding: {
          valid: true,
          unsupportedEvidenceCount: 0,
        },
      },
    };

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          evidenceResolver: {},
        },
      }),
    ).toThrow();

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          approvalBindingHash: 'secret-internal-binding',
        },
      }),
    ).toThrow();

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          toolTrace: [
            {
              toolName: 'task_create',
              status: 'ok',
              durationMs: 1,
              evidenceCount: 0,
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...base,
        data: {
          ...base.data,
          toolTrace: [
            {
              toolName: 'account_get_context',
              status: 'ok',
              durationMs: 1,
              evidenceCount: 1,
              arguments: { account_ref: 'Acme Labs' },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('keeps failure responses bounded and strict', () => {
    const failure = {
      version: '1',
      requestId,
      success: false,
      code: 'MCP_UNAVAILABLE',
      error: 'ClientOps MCP service is temporarily unavailable.',
    };

    expect(AgentInvocationResponseV1Schema.parse(failure)).toEqual(failure);
    expect(() =>
      AgentInvocationResponseV1Schema.parse({
        ...failure,
        stack: '/app/internal/path.ts:123',
      }),
    ).toThrow();
  });
});
