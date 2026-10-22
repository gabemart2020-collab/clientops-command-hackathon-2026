import { describe, expect, it, vi } from 'vitest';
import type { ToolList } from '@strands-agents/sdk';
import type { AgentRunResult } from '@clientops/agent';
import {
  PHASE5_2_CERTIFICATION_MODEL_ID,
  type AgentInvocationResponseV1,
} from '@clientops/contracts';
import { AgentCoreMcpProtocolError } from './agentcore-mcp.js';
import { parseAgentRuntimeServiceConfig } from './config.js';
import {
  createAgentRuntimeHandler,
  type AgentRuntimeAgent,
  type ProposalRegistrar,
} from './handler.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000011';
const requestId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

const config = parseAgentRuntimeServiceConfig({
  host: '0.0.0.0',
  port: 8080,
  awsRegion: 'us-east-1',
  modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
  mcpRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/clientops_mcp_example-EXAMPLE123',
  mcpQualifier: 'DEFAULT',
  certificationOrganizationId: organizationId,
  certificationActorId: actorId,
  maxBodyBytes: 65_536,
  maxTurns: 6,
  maxOutputTokens: 2000,
  maxTotalTokens: 12_000,
  timeoutMs: 30_000,
  temperature: 0.1,
});

const validRequest = {
  version: '1' as const,
  requestId,
  sessionId,
  organizationId,
  actorId,
  userMessage: 'Prepare the Acme review brief.',
  accountHint: 'Acme Labs',
};

function refusalResult(): AgentRunResult {
  return {
    success: true,
    brief: {
      mode: 'capability_refusal',
      refusalReason: 'The requested write is unsupported.',
      answer: 'The requested action was not executed.',
      findings: [],
      suggestedNextSteps: ['Ask a human operator to perform the action.'],
    },
    toolTrace: [
      {
        toolName: 'account_get_context',
        arguments: { account_ref: 'Acme Labs', secretToken: '[REDACTED]' },
        durationMs: 9,
        status: 'ok',
        evidenceReferences: [],
      },
    ],
    modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
    stopReason: 'end_turn',
    latencyMs: 50,
    grounding: {
      valid: true,
      groundedEvidenceCount: 0,
      unsupportedEvidenceCount: 0,
      authoritativeEvidenceCount: 0,
      unsupportedReferences: [],
    },
  };
}

function proposalResult(): AgentRunResult {
  return {
    success: true,
    brief: {
      mode: 'action_proposal',
      answer:
        'The task was not created or executed. Human approval is required before any task can be created.',
      findings: [],
      suggestedNextSteps: ['Review the task proposal.'],
      proposedAction: {
        actionType: 'task.create',
        parameters: {
          clientId: 'c0000000-0000-4000-8000-000000000001',
          projectId: 'a0000000-0000-4000-8000-000000000001',
          title: 'Prepare rollback runbook',
          priority: 'medium',
        },
        justification:
          'An overdue migration milestone requires a rollback runbook.',
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
    latencyMs: 75,
    grounding: {
      valid: true,
      groundedEvidenceCount: 1,
      unsupportedEvidenceCount: 0,
      authoritativeEvidenceCount: 1,
      unsupportedReferences: [],
    },
    evidenceResolver: {
      resolveCitation: () => ({
        success: true,
        resolved: {
          entityType: 'project',
          entityId: 'a0000000-0000-4000-8000-000000000001',
          field: 'updated_at',
          excerpt: '2026-10-01T00:00:00.000Z',
        },
      }),
    },
  };
}

function agentFor(result: AgentRunResult): AgentRuntimeAgent {
  return {
    prepareClientBrief: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function successBody(body: AgentInvocationResponseV1) {
  if (!body.success) throw new Error('expected success');
  return body.data;
}

describe('Phase 5.2.1 Agent Runtime handler', () => {
  it('rejects identity mismatch before loading tools or running the agent', async () => {
    const loadTools = vi.fn<() => Promise<ToolList>>().mockResolvedValue([]);
    const createAgent = vi.fn(() => agentFor(refusalResult()));
    const handler = createAgentRuntimeHandler(config, {
      loadTools,
      createAgent,
    });

    const result = await handler({
      ...validRequest,
      actorId: '10000000-0000-4000-8000-000000000099',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.success).toBe(false);
    if (!result.body.success) {
      expect(result.body.code).toBe('CERTIFICATION_IDENTITY_MISMATCH');
    }
    expect(loadTools).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects a mismatched certification organization before proposal registration', async () => {
    const registrar: ProposalRegistrar = {
      register: vi.fn(),
    };
    const loadTools = vi.fn<() => Promise<ToolList>>().mockResolvedValue([]);
    const createAgent = vi.fn(() => agentFor(proposalResult()));
    const handler = createAgentRuntimeHandler(config, {
      loadTools,
      createAgent,
      proposalRegistrar: registrar,
    });

    const result = await handler({
      ...validRequest,
      organizationId: '10000000-0000-4000-8000-000000000099',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.success).toBe(false);
    if (!result.body.success) {
      expect(result.body.code).toBe('CERTIFICATION_IDENTITY_MISMATCH');
    }
    expect(loadTools).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it('rejects a mismatched certification actor before proposal registration', async () => {
    const registrar: ProposalRegistrar = {
      register: vi.fn(),
    };
    const loadTools = vi.fn<() => Promise<ToolList>>().mockResolvedValue([]);
    const createAgent = vi.fn(() => agentFor(proposalResult()));
    const handler = createAgentRuntimeHandler(config, {
      loadTools,
      createAgent,
      proposalRegistrar: registrar,
    });

    const result = await handler({
      ...validRequest,
      actorId: '10000000-0000-4000-8000-000000000099',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.success).toBe(false);
    if (!result.body.success) {
      expect(result.body.code).toBe('CERTIFICATION_IDENTITY_MISMATCH');
    }
    expect(loadTools).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it('returns only the frozen sanitized public success envelope', async () => {
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => agentFor(refusalResult()),
    });

    const result = await handler(validRequest);
    expect(result.statusCode).toBe(200);
    const data = successBody(result.body);

    expect(data.modelId).toBe(PHASE5_2_CERTIFICATION_MODEL_ID);
    expect(data.grounding).toEqual({
      valid: true,
      unsupportedEvidenceCount: 0,
    });
    expect(data.toolTrace).toEqual([
      {
        toolName: 'account_get_context',
        status: 'ok',
        durationMs: 9,
        evidenceCount: 0,
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain('secretToken');
    expect(JSON.stringify(result.body)).not.toContain('arguments');
  });

  it('classifies bounded Bedrock authentication failure before grounding failure', async () => {
    const failed: AgentRunResult = {
      success: false,
      toolTrace: [],
      modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
      stopReason: 'error',
      latencyMs: 5,
      grounding: {
        valid: false,
        groundedEvidenceCount: 0,
        unsupportedEvidenceCount: 0,
        authoritativeEvidenceCount: 0,
        unsupportedReferences: [],
      },
      error:
        'AWS_BEDROCK_AUTH_ERROR: Bedrock credentials unavailable or unauthorized.',
    };
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => agentFor(failed),
    });

    const result = await handler(validRequest);
    expect(result.statusCode).toBe(503);
    expect(result.body.success).toBe(false);
    if (!result.body.success) {
      expect(result.body.code).toBe('AWS_BEDROCK_AUTH_ERROR');
    }
  });

  it('fails closed when proposal persistence is not configured', async () => {
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => agentFor(proposalResult()),
    });

    const result = await handler(validRequest);
    expect(result.statusCode).toBe(503);
    expect(result.body.success).toBe(false);
    if (!result.body.success) {
      expect(result.body.code).toBe('ACTION_STORE_UNAVAILABLE');
    }
  });

  it('registers a grounded proposal with requestId as the correlation/idempotency key', async () => {
    const registrar: ProposalRegistrar = {
      register: vi.fn().mockResolvedValue({
        proposalId: '33333333-3333-4333-8333-333333333333',
        status: 'PENDING_APPROVAL',
        reviewUrl: '/actions/33333333-3333-4333-8333-333333333333',
      }),
    };
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => agentFor(proposalResult()),
      proposalRegistrar: registrar,
    });

    const result = await handler(validRequest);
    expect(result.statusCode).toBe(200);
    const data = successBody(result.body);
    expect(data.actionProposal).toEqual({
      proposalId: '33333333-3333-4333-8333-333333333333',
      status: 'PENDING_APPROVAL',
      reviewUrl: '/actions/33333333-3333-4333-8333-333333333333',
    });
    expect(registrar.register).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        actorId,
        requestId,
      }),
    );
  });

  it('never leaks SQL exception details to logs or response', async () => {
    const logger = { error: vi.fn() };
    const registrar: ProposalRegistrar = {
      register: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'postgresql://user:password@host/db secret-token approval-hash SQLSTATE 23505 duplicate key constraint action_proposals_org_correlation_key DETAIL: Key (organization_id, correlation_id) already exists. STATEMENT: INSERT INTO action_proposals',
          ),
        ),
    };
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => agentFor(proposalResult()),
      proposalRegistrar: registrar,
      logger,
    });

    const result = await handler(validRequest);
    const serialized = JSON.stringify({
      result,
      logs: logger.error.mock.calls,
    });

    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('approval-hash');
    expect(serialized).not.toContain('SQLSTATE');
    expect(serialized).not.toContain('duplicate key');
    expect(serialized).not.toContain('action_proposals_org_correlation_key');
    expect(serialized).not.toContain('INSERT INTO action_proposals');
    expect(logger.error).toHaveBeenCalledWith(
      'agent_runtime_proposal_registration_failed',
      {
        code: 'ACTION_PROPOSAL_REGISTRATION_FAILED',
        errorType: 'Error',
      },
    );
  });

  it('redacts untrusted exception names and messages across runtime failure boundaries', async () => {
    const secret =
      'postgresql://user:password@host/db raw-mcp-evidence approval-binding-hash';
    const hostile = new Error(secret);
    hostile.name = 'InjectedError ' + secret;
    const scenarios = [
      {
        name: 'tool loading',
        dependencies: {
          loadTools: vi
            .fn<() => Promise<ToolList>>()
            .mockRejectedValue(hostile),
          createAgent: () => agentFor(refusalResult()),
        },
        expectedCode: 'SERVER_ERROR',
        expectedEvent: 'agent_runtime_invocation_failed',
      },
      {
        name: 'MCP invocation',
        dependencies: {
          loadTools: async () => [],
          createAgent: () => ({
            prepareClientBrief: vi
              .fn()
              .mockRejectedValue(
                new AgentCoreMcpProtocolError('mcp ' + secret),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }),
        },
        expectedCode: 'MCP_UNAVAILABLE',
        expectedEvent: 'agent_runtime_invocation_failed',
      },
      {
        name: 'proposal registration',
        dependencies: {
          loadTools: async () => [],
          createAgent: () => agentFor(proposalResult()),
          proposalRegistrar: { register: vi.fn().mockRejectedValue(hostile) },
        },
        expectedCode: 'ACTION_PROPOSAL_REGISTRATION_FAILED',
        expectedEvent: 'agent_runtime_proposal_registration_failed',
      },
    ] as const;

    for (const scenario of scenarios) {
      const logger = { error: vi.fn() };
      const handler = createAgentRuntimeHandler(config, {
        ...scenario.dependencies,
        logger,
      });
      const result = await handler(validRequest);
      expect(result.body.success, scenario.name).toBe(false);
      if (!result.body.success) {
        expect(result.body.code).toBe(scenario.expectedCode);
      }
      expect(logger.error).toHaveBeenCalledWith(
        scenario.expectedEvent,
        expect.objectContaining({ errorType: 'UnknownError' }),
      );
      const serialized = JSON.stringify({
        result,
        logs: logger.error.mock.calls,
      });
      for (const forbidden of [
        'password',
        'raw-mcp-evidence',
        'approval-binding-hash',
        'InjectedError',
      ]) {
        expect(serialized, scenario.name).not.toContain(forbidden);
      }
    }
  });

  it('does not expose cleanup exceptions after a successful invocation', async () => {
    const logger = { error: vi.fn() };
    const close = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('raw-mcp-evidence password approval-binding-hash'),
        {
          name: 'HostileCleanupError',
        },
      ),
    );
    const handler = createAgentRuntimeHandler(config, {
      loadTools: async () => [],
      createAgent: () => ({
        prepareClientBrief: vi.fn().mockResolvedValue(refusalResult()),
        close,
      }),
      logger,
    });
    const result = await handler(validRequest);
    expect(result.statusCode).toBe(200);
    expect(close).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'agent_runtime_agent_cleanup_failed',
      { code: 'AGENT_CLEANUP_FAILED' },
    );
    const serialized = JSON.stringify({
      result,
      logs: logger.error.mock.calls,
    });
    for (const forbidden of [
      'password',
      'raw-mcp-evidence',
      'approval-binding-hash',
      'HostileCleanupError',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
