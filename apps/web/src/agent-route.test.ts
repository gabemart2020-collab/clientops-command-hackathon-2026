import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './app/api/agent/route.js';
import {
  sanitizeLogMessage,
  classifyProposalErrorType,
  sanitizePublicToolTrace,
} from './lib/sanitize.js';
import {
  getActionServerContext,
  createInMemoryActionServerContext,
  setActionServerContextForTesting,
  ActionStoreUnavailableError,
} from './lib/action-context.js';
import {
  ProposalRegistrationError,
  ProposalEvidenceResolutionError,
  type AuthoritativeEvidenceResolver,
} from '@clientops/policy';
import { ZodError } from 'zod';

const mockPrepareClientBrief = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@clientops/agent', () => {
  return {
    ClientOpsAgent: class {
      prepareClientBrief = mockPrepareClientBrief;
      close = mockClose;
    },
  };
});

describe('apps/web: POST /api/agent Lifecycle and Error Boundaries', () => {
  beforeEach(() => {
    mockPrepareClientBrief.mockReset();
    mockClose.mockReset().mockResolvedValue(undefined);
  });

  describe('Agent Lifecycle Teardown', () => {
    it('closes agent deterministically on successful execution', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 5,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 5,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'briefing',
          answer: 'All clear.',
          findings: [],
          suggestedNextSteps: [],
        },
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Review status' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('closes agent deterministically on AgentRunResult failure', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: false,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'error',
        latencyMs: 100,
        toolTrace: [],
        grounding: {
          valid: false,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 0,
          unsupportedReferences: [],
        },
        error: 'Execution failed',
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Review status' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('closes agent deterministically on thrown exception', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockPrepareClientBrief.mockRejectedValue(new Error('Fatal exception'));

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Review status' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(500);

        const body = await response.json();
        expect(body.success).toBe(false);
        expect(mockClose).toHaveBeenCalledTimes(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('Secret-Safe Server Logging and Response Boundaries', () => {
    it('guarantees console.error receives only bounded metadata and never receives sensitive values or arbitrary exception text', async () => {
      const jsonPassword = '{"password":"superSecretPassword"}';
      const jsonSessionToken = '{"AWS_SESSION_TOKEN":"long-token-987654321"}';
      const basicAuth = 'Authorization: Basic sensitiveBasicToken123==';
      const bearerToken =
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ae';
      const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';
      const awsSecretKey =
        'AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const internalPath =
        '/var/run/secrets/kubernetes.io/serviceaccount/token';
      const workspacePath =
        '/workspaces/clientops-command/packages/agent/src/secret.ts';
      const rawException = `Fatal database crash: ${jsonPassword} ${jsonSessionToken} ${basicAuth} ${bearerToken} ${awsAccessKey} ${awsSecretKey} at ${internalPath} and ${workspacePath}`;

      mockPrepareClientBrief.mockRejectedValue(new Error(rawException));

      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Tell me about Acme' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(500);

        const body = await response.json();
        expect(body.success).toBe(false);
        expect(body.code).toBe('SERVER_ERROR');

        // Check console.error calls
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const [tag, metadata] = consoleSpy.mock.calls[0] ?? [];

        // Assert safe error code and type metadata are preserved
        expect(tag).toBe('[API /api/agent Error]');
        expect(metadata).toEqual({
          code: 'SERVER_ERROR',
          errorType: 'Error',
        });

        // Stringify all arguments passed to console.error
        const loggedPayload = JSON.stringify(consoleSpy.mock.calls);

        // Prove the logger never receives JSON-formatted password values
        expect(loggedPayload).not.toContain('superSecretPassword');
        expect(loggedPayload).not.toContain('password');

        // Prove the logger never receives JSON-formatted AWS_SESSION_TOKEN
        expect(loggedPayload).not.toContain('AWS_SESSION_TOKEN');
        expect(loggedPayload).not.toContain('long-token-987654321');

        // Prove the logger never receives Authorization: Basic credentials
        expect(loggedPayload).not.toContain('sensitiveBasicToken123==');
        expect(loggedPayload).not.toContain('Basic');

        // Prove the logger never receives Bearer credentials
        expect(loggedPayload).not.toContain(
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        );
        expect(loggedPayload).not.toContain('Bearer');

        // Prove the logger never receives AWS access/secret keys
        expect(loggedPayload).not.toContain(awsAccessKey);
        expect(loggedPayload).not.toContain(
          'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        );

        // Prove the logger never receives internal filesystem paths
        expect(loggedPayload).not.toContain(internalPath);
        expect(loggedPayload).not.toContain('/var/run/secrets');
        expect(loggedPayload).not.toContain('/workspaces/clientops-command');

        // Prove the logger never receives arbitrary raw exception text
        expect(loggedPayload).not.toContain('Fatal database crash');
        expect(loggedPayload).not.toContain(rawException);

        // Verify response payload never leaks secrets or internal paths
        const jsonString = JSON.stringify(body);
        expect(jsonString).not.toContain(
          'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        );
        expect(jsonString).not.toContain(internalPath);
        expect(jsonString).not.toContain('Fatal database crash');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('logs bounded metadata for classified connection or auth errors without logging raw message text', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockPrepareClientBrief.mockRejectedValue(
        new Error(
          'connect ECONNREFUSED 127.0.0.1:4000 at /workspaces/clientops-command/net.ts',
        ),
      );

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Check MCP' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(503);

        const body = await response.json();
        expect(body.code).toBe('MCP_UNAVAILABLE');

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const [tag, metadata] = consoleSpy.mock.calls[0] ?? [];
        expect(tag).toBe('[API /api/agent Error]');
        expect(metadata).toEqual({
          code: 'MCP_UNAVAILABLE',
          errorType: 'Error',
        });

        const loggedPayload = JSON.stringify(consoleSpy.mock.calls);
        expect(loggedPayload).not.toContain('ECONNREFUSED');
        expect(loggedPayload).not.toContain('127.0.0.1:4000');
        expect(loggedPayload).not.toContain('/workspaces/clientops-command');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('logs bounded metadata for classified AWS credential errors without leaking raw credential details', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockPrepareClientBrief.mockRejectedValue(
        new Error(
          'AccessDeniedException: The security token included in the request is invalid for credential AKIAIOSFODNN7EXAMPLE',
        ),
      );

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Check Bedrock' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(503);

        const body = await response.json();
        expect(body.code).toBe('AWS_BEDROCK_AUTH_ERROR');

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const [tag, metadata] = consoleSpy.mock.calls[0] ?? [];
        expect(tag).toBe('[API /api/agent Error]');
        expect(metadata).toEqual({
          code: 'AWS_BEDROCK_AUTH_ERROR',
          errorType: 'Error',
        });

        const loggedPayload = JSON.stringify(consoleSpy.mock.calls);
        expect(loggedPayload).not.toContain('AccessDeniedException');
        expect(loggedPayload).not.toContain('security token');
        expect(loggedPayload).not.toContain('AKIAIOSFODNN7EXAMPLE');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('bounds arbitrary agent result errors and does not echo unmapped error text', async () => {
      const rawInternalProviderError =
        'InternalProviderError: connection to 10.200.0.1:443 timed out with internal state { traceId: 9999 }';

      mockPrepareClientBrief.mockResolvedValue({
        success: false,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'error',
        latencyMs: 120,
        toolTrace: [],
        grounding: {
          valid: false,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 0,
          unsupportedReferences: [],
        },
        error: rawInternalProviderError,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Review Acme' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('AGENT_EXECUTION_FAILED');
      expect(body.error).toBe('Agentic briefing preparation failed.');

      const jsonString = JSON.stringify(body);
      expect(jsonString).not.toContain(rawInternalProviderError);
      expect(jsonString).not.toContain('10.200.0.1');
      expect(body.data).toBeUndefined(); // Does not leak raw data object on failure
    });

    it('maps grounding failure to bounded 422 with public code', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: false,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 250,
        toolTrace: [],
        grounding: {
          valid: false,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 2,
          authoritativeEvidenceCount: 5,
          unsupportedReferences: [],
          message:
            'Grounding validation failed: 2 unsupported evidence reference(s).',
        },
        error: 'Grounding validation failed: unsupported references',
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Status check' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('GROUNDING_VALIDATION_FAILED');
      expect(body.error).toBe(
        'Brief failed grounding validation: one or more statements lacked authoritative evidence.',
      );
      expect(body.meta.grounding.valid).toBe(false);
      expect(body.meta.grounding.unsupportedEvidenceCount).toBe(2);
    });

    it('sanitizeLogMessage redacts credentials, tokens, passwords, and paths directly', () => {
      const raw =
        'Error: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE api_key="secret-key-123" Bearer eyJtoken password: mySecretPassword in /home/user/app/index.ts';
      const sanitized = sanitizeLogMessage(raw);

      expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(sanitized).not.toContain('secret-key-123');
      expect(sanitized).not.toContain('eyJtoken');
      expect(sanitized).not.toContain('mySecretPassword');
      expect(sanitized).not.toContain('/home/user/app/index.ts');

      expect(sanitized).toContain('AWS_ACCESS_KEY_ID=[REDACTED]');
      expect(sanitized).toContain('api_key=[REDACTED]');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).toContain('[PATH]');
    });
  });

  describe('Proposal Handoff and Lifecycle Integration Suite', () => {
    const priorWriteFlag = process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
    const validProposedAction = {
      actionType: 'task.create' as const,
      parameters: {
        clientId: 'c0000000-0000-4000-8000-000000000001',
        projectId: 'a0000000-0000-4000-8000-000000000001',
        title: 'Setup executive incident review',
        description: 'Prepare executive incident briefing pack',
      },
      justification: 'Incident requires executive incident briefing.',
      citations: [
        {
          entityType: 'meeting' as const,
          entityId: '40000000-0000-4000-8000-000000000001',
          field: 'summary',
        },
      ],
    };

    const mockResolver: AuthoritativeEvidenceResolver = {
      resolveCitation: (citation) => ({
        success: true,
        resolved: {
          entityType: citation.entityType,
          entityId: citation.entityId,
          field: citation.field,
          excerpt: 'Authoritative meeting summary excerpt',
        },
      }),
    };

    beforeEach(() => {
      process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED = 'true';
      setActionServerContextForTesting(createInMemoryActionServerContext());
    });

    afterEach(() => {
      setActionServerContextForTesting(null);
      if (priorWriteFlag === undefined) {
        delete process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
      } else {
        process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED = priorWriteFlag;
      }
    });

    it('read-only gate blocks grounded proposals without touching the action store', async () => {
      delete process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED;
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-sonnet-4-6',
        stopReason: 'end_turn',
        latencyMs: 100,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer: 'Task proposal requires approval.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      // Even a valid model proposal cannot become a durable record without opt-in.
      const ctx = getActionServerContext();
      const before = await ctx.actionProposalRepository.listPending(ctx.tenant);
      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('ACTION_WRITES_DISABLED');
      expect(
        await ctx.actionProposalRepository.listPending(ctx.tenant),
      ).toEqual(before);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('true agent handoff: registers valid action_proposal in PENDING_APPROVAL and returns 200 with review metadata', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 300,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Submit for human approval'],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task for the incident' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.actionProposal).toBeDefined();
      expect(body.data.actionProposal.status).toBe('PENDING_APPROVAL');
      expect(body.data.actionProposal.reviewUrl).toMatch(
        /^\/actions\/[0-9a-f-]+$/,
      );

      const proposalId = body.data.actionProposal.proposalId;
      const actionCtx = getActionServerContext();
      const persisted = await actionCtx.actionProposalRepository.findById(
        actionCtx.tenant,
        proposalId,
      );
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe('PENDING_APPROVAL');

      // Verify ZERO executions and ZERO tasks
      const tasks = await actionCtx.dataStore.tasks.listByProject(
        actionCtx.tenant,
        'a0000000-0000-4000-8000-000000000001',
      );
      expect(
        tasks.some((t) => t.title === 'Setup executive incident review'),
      ).toBe(false);
    });

    it('A. task.create with valid assigneeUserId hydrates authoritative assigneeDisplayName in PENDING_APPROVAL', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 250,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Submit for human approval'],
          proposedAction: {
            ...validProposedAction,
            parameters: {
              ...validProposedAction.parameters,
              assigneeUserId: '10000000-0000-4000-8000-000000000011',
            },
          },
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Assign task to Alice' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.actionProposal.status).toBe('PENDING_APPROVAL');

      const actionCtx = getActionServerContext();
      const persisted = await actionCtx.actionProposalRepository.findById(
        actionCtx.tenant,
        body.data.actionProposal.proposalId,
      );
      expect(persisted).not.toBeNull();
      expect(persisted!.parameters.assigneeUserId).toBe(
        '10000000-0000-4000-8000-000000000011',
      );
      // Server-hydrated authoritative display name from user repository
      expect(persisted!.parameters.assigneeDisplayName).toBe('Alice Walker');
    });

    it('B. task.create with valid milestoneId belonging to project registers PENDING_APPROVAL', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 250,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Submit for human approval'],
          proposedAction: {
            ...validProposedAction,
            parameters: {
              ...validProposedAction.parameters,
              milestoneId: 'b0000000-0000-4000-8000-000000000001',
            },
          },
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Attach milestone to task' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.actionProposal.status).toBe('PENDING_APPROVAL');

      const actionCtx = getActionServerContext();
      const persisted = await actionCtx.actionProposalRepository.findById(
        actionCtx.tenant,
        body.data.actionProposal.proposalId,
      );
      expect(persisted).not.toBeNull();
      expect(persisted!.parameters.milestoneId).toBe(
        'b0000000-0000-4000-8000-000000000001',
      );
    });

    it('C. milestoneId from wrong project rejects registration with 422, zero durable proposal', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 250,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Submit for human approval'],
          proposedAction: {
            ...validProposedAction,
            parameters: {
              ...validProposedAction.parameters,
              // milestoneNorthstar belongs to projectNorthstar, not projectAcmeMigration
              milestoneId: 'b0000000-0000-4000-8000-000000000004',
            },
          },
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: 'Create cross-project milestone task',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('ACTION_PROPOSAL_REGISTRATION_FAILED');

      const actionCtx = getActionServerContext();
      const proposals = await actionCtx.actionProposalRepository.listPending(
        actionCtx.tenant,
      );
      expect(proposals).toHaveLength(0);
    });

    it('D. assigneeUserId not in tenant rejects registration with 422, zero durable proposal', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 250,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an authorized operator is required.',
          findings: [],
          suggestedNextSteps: ['Submit for human approval'],
          proposedAction: {
            ...validProposedAction,
            parameters: {
              ...validProposedAction.parameters,
              assigneeUserId: '90000000-0000-4000-8000-000000000099', // foreign/non-existent user
            },
          },
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Assign to invalid user' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('ACTION_PROPOSAL_REGISTRATION_FAILED');

      const actionCtx = getActionServerContext();
      const proposals = await actionCtx.actionProposalRepository.listPending(
        actionCtx.tenant,
      );
      expect(proposals).toHaveLength(0);
    });

    it('contradictory mode rejection: operational mode with proposedAction returns 400 INVALID_PROPOSAL_MODE', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'operational',
          answer: 'All clear.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Review status' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('INVALID_PROPOSAL_MODE');
    });

    it('contradictory mode rejection: capability_refusal mode with proposedAction returns 400 INVALID_PROPOSAL_MODE', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'capability_refusal',
          refusalReason: 'Read only agent.',
          answer: 'Cannot create tasks.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('INVALID_PROPOSAL_MODE');
    });

    it('fabricated citation failure: grounding.valid = false in action_proposal mode returns 422 GROUNDING_VALIDATION_FAILED', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: false,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 1,
          authoritativeEvidenceCount: 0,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer: 'The task has not been created. Human approval is required.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('GROUNDING_VALIDATION_FAILED');
    });

    it('missing resolver failure: missing evidenceResolver returns 422 ACTION_PROPOSAL_REGISTRATION_FAILED', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer: 'The task has not been created. Human approval is required.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: undefined,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(422);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('ACTION_PROPOSAL_REGISTRATION_FAILED');
    });

    it('resolver absence in JSON: serialized JSON response strictly excludes evidenceResolver, facts, and internal registries', async () => {
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an operator is required.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
        authoritativeEvidence: [{ id: 'secret-auth-evidence' }],
        allAuthoritativeEvidence: [{ id: 'secret-all-evidence' }],
        facts: [{ statement: 'internal fact' }],
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const rawJson = await response.text();
      expect(rawJson).not.toContain('evidenceResolver');
      expect(rawJson).not.toContain('authoritativeEvidence');
      expect(rawJson).not.toContain('allAuthoritativeEvidence');
      expect(rawJson).not.toContain('facts');
      expect(rawJson).not.toContain('secret-auth-evidence');
      expect(rawJson).not.toContain('secret-all-evidence');
    });

    it('secret-safe proposal registration exception logging: never logs credentials, DB URLs, paths, or raw exception text', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const secretAwsKey = 'AKIAIOSFODNN7EXAMPLE';
      const secretBearer =
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ae';
      const secretDbUrl =
        'postgresql://postgres:mySuperSecretPassword@db.internal:5432/clientops';
      const secretPath = '/var/run/secrets/credentials.json';
      const secretJson = '{"password":"superSecretDatabasePassword"}';
      const exceptionWithSecrets = new Error(
        `Registration crash: ${secretAwsKey} ${secretBearer} ${secretDbUrl} ${secretPath} ${secretJson}`,
      );

      const failingCtx = createInMemoryActionServerContext();
      failingCtx.transactionRunner = async () => {
        throw exceptionWithSecrets;
      };
      setActionServerContextForTesting(failingCtx);

      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer:
            'The task has not been created or executed. Human approval from an operator is required.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(422);

        const body = await response.json();
        expect(body.success).toBe(false);
        expect(body.code).toBe('ACTION_PROPOSAL_REGISTRATION_FAILED');
        expect(body.error).toContain(
          'Zero actions were persisted, approved, or executed',
        );

        // Verify console.error receives ONLY bounded metadata
        expect(consoleErrorSpy).toHaveBeenCalled();
        const loggedPayload = JSON.stringify(consoleErrorSpy.mock.calls);
        expect(loggedPayload).toContain(
          '[API /api/agent Proposal Registration Error]',
        );
        expect(loggedPayload).toContain('ACTION_PROPOSAL_REGISTRATION_FAILED');

        // Prove secrets were scrubbed from logs
        expect(loggedPayload).not.toContain(secretAwsKey);
        expect(loggedPayload).not.toContain(secretBearer);
        expect(loggedPayload).not.toContain('mySuperSecretPassword');
        expect(loggedPayload).not.toContain(secretDbUrl);
        expect(loggedPayload).not.toContain(secretPath);
        expect(loggedPayload).not.toContain('superSecretDatabasePassword');
        expect(loggedPayload).not.toContain('Registration crash');

        // Prove secrets were scrubbed from response body
        const responseText = JSON.stringify(body);
        expect(responseText).not.toContain(secretAwsKey);
        expect(responseText).not.toContain(secretBearer);
        expect(responseText).not.toContain('mySuperSecretPassword');
        expect(responseText).not.toContain(secretDbUrl);
        expect(responseText).not.toContain(secretPath);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('bounded proposal error classification regression: normalizes manipulated Error.name and never logs secrets', async () => {
      // 1. Direct unit verification of classifyProposalErrorType
      expect(
        classifyProposalErrorType(new ActionStoreUnavailableError('test')),
      ).toBe('ACTION_STORE_UNAVAILABLE');
      expect(
        classifyProposalErrorType(new ProposalRegistrationError('test')),
      ).toBe('PROPOSAL_REGISTRATION_ERROR');
      expect(
        classifyProposalErrorType(
          new ProposalEvidenceResolutionError(
            {
              entityType: 'milestone',
              entityId: '10000000-0000-4000-8000-000000000001',
              field: 'status',
            },
            'test',
          ),
        ),
      ).toBe('PROPOSAL_REGISTRATION_ERROR');
      expect(classifyProposalErrorType(new ZodError([]))).toBe(
        'VALIDATION_ERROR',
      );

      // Manipulated Error.name with AWS credentials and secrets
      const evilError = new Error('database connection dropped');
      evilError.name = 'AKIAIOSFODNN7EXAMPLE /var/run/secrets/token';
      expect(classifyProposalErrorType(evilError)).toBe('UNKNOWN_ERROR');
      expect(classifyProposalErrorType(null)).toBe('UNKNOWN_ERROR');
      expect(classifyProposalErrorType('string error')).toBe('UNKNOWN_ERROR');

      // 2. Route-level integration test
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const failingCtx = createInMemoryActionServerContext();
      failingCtx.transactionRunner = async () => {
        throw evilError;
      };
      setActionServerContextForTesting(failingCtx);

      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: [],
        grounding: {
          valid: true,
          groundedEvidenceCount: 1,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 1,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'action_proposal',
          answer: 'The task has not been created or executed.',
          findings: [],
          suggestedNextSteps: [],
          proposedAction: validProposedAction,
        },
        evidenceResolver: mockResolver,
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Create a task' }),
      });

      try {
        const response = await POST(request);
        expect(response.status).toBe(422);

        expect(consoleErrorSpy).toHaveBeenCalled();
        const loggedPayload = JSON.stringify(consoleErrorSpy.mock.calls);
        // Proves errorType is strictly 'UNKNOWN_ERROR' and does NOT leak evilError.name
        expect(loggedPayload).toContain('"errorType":"UNKNOWN_ERROR"');
        expect(loggedPayload).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(loggedPayload).not.toContain('/var/run/secrets/token');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('public tool trace sanitization regression: strips errorMessage and arguments containing sensitive credentials', async () => {
      // 1. Direct unit verification of sanitizePublicToolTrace
      const rawTrace = [
        {
          toolName: 'get_milestones',
          status: 'error',
          durationMs: 45,
          errorMessage:
            'Connection failed: postgresql://postgres:secretPass@db.internal:5432/db AKIAIOSFODNN7EXAMPLE',
          arguments: {
            clientId: '10000000-0000-4000-8000-000000000002',
            secretApiKey: 'sk-ant-live-secret-key-12345',
          },
          evidenceReferences: [{ id: 'ev-1' }, { id: 'ev-2' }],
        },
        {
          toolName: 'get_client_summary',
          status: 'ok',
          durationMs: 120,
          evidenceReferences: [],
        },
      ];

      const sanitized = sanitizePublicToolTrace(rawTrace);
      expect(sanitized).toEqual([
        {
          toolName: 'get_milestones',
          status: 'error',
          durationMs: 45,
          evidenceCount: 2,
        },
        {
          toolName: 'get_client_summary',
          status: 'ok',
          durationMs: 120,
          evidenceCount: 0,
        },
      ]);

      const sanitizedJson = JSON.stringify(sanitized);
      expect(sanitizedJson).not.toContain('secretPass');
      expect(sanitizedJson).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(sanitizedJson).not.toContain('sk-ant-live-secret-key');
      expect(sanitizedJson).not.toContain('errorMessage');
      expect(sanitizedJson).not.toContain('arguments');

      // Non-array returns empty array safely
      expect(sanitizePublicToolTrace(null)).toEqual([]);
      expect(sanitizePublicToolTrace(undefined)).toEqual([]);

      // 2. Route-level integration test
      mockPrepareClientBrief.mockResolvedValue({
        success: true,
        modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        stopReason: 'end_turn',
        latencyMs: 150,
        toolTrace: rawTrace,
        grounding: {
          valid: true,
          groundedEvidenceCount: 0,
          unsupportedEvidenceCount: 0,
          authoritativeEvidenceCount: 0,
          unsupportedReferences: [],
        },
        brief: {
          mode: 'operational',
          answer: 'All systems normal.',
          findings: [],
          suggestedNextSteps: [],
        },
      });

      const request = new Request('http://localhost:3000/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'Status check' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const responseText = await response.text();
      // Crucial assertion: response JSON never contains credentials or sensitive fields from tool trace
      expect(responseText).not.toContain('secretPass');
      expect(responseText).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(responseText).not.toContain('sk-ant-live-secret-key');
      expect(responseText).not.toContain('errorMessage');

      const body = JSON.parse(responseText);
      expect(body.data.toolTrace).toEqual([
        {
          toolName: 'get_milestones',
          status: 'error',
          durationMs: 45,
          evidenceCount: 2,
        },
        {
          toolName: 'get_client_summary',
          status: 'ok',
          durationMs: 120,
          evidenceCount: 0,
        },
      ]);
    });
  });
});
