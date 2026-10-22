import { NextResponse } from 'next/server';
import { ClientOpsAgent } from '@clientops/agent';
import {
  registerActionProposal,
  type AuthoritativeEvidenceResolver,
} from '@clientops/policy';
import {
  getActionServerContext,
  ActionStoreUnavailableError,
} from '@/lib/action-context';
import {
  classifyProposalErrorType,
  sanitizePublicToolTrace,
} from '@/lib/sanitize';
import { areWebActionWritesEnabled } from '@/lib/web-action-write-gate';

export async function POST(request: Request) {
  let agent: ClientOpsAgent | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    const userMessage =
      typeof body.userMessage === 'string' && body.userMessage.trim()
        ? body.userMessage.trim()
        : "Prepare me for tomorrow's Acme review.";

    const accountHint =
      typeof body.accountHint === 'string' && body.accountHint.trim()
        ? body.accountHint.trim()
        : undefined;

    agent = new ClientOpsAgent();
    const result = await agent.prepareClientBrief({
      userMessage,
      ...(accountHint ? { accountHint } : {}),
    });

    if (!result.success) {
      const errText = (result.error ?? '').toLowerCase();
      let code = 'AGENT_EXECUTION_FAILED';
      let statusCode = 400;
      let publicMessage = 'Agentic briefing preparation failed.';

      if (errText.includes('mcp') || errText.includes('econnrefused')) {
        code = 'MCP_UNAVAILABLE';
        statusCode = 503;
        publicMessage =
          'ClientOps MCP service is currently unreachable. Ensure the local service is running.';
      } else if (
        errText.includes('auth') ||
        errText.includes('credential') ||
        errText.includes('accessdenied')
      ) {
        code = 'AWS_BEDROCK_AUTH_ERROR';
        statusCode = 503;
        publicMessage =
          'Amazon Bedrock credentials unavailable or unauthorized. Verify AWS environment and IAM permissions.';
      } else if (errText.includes('model') || errText.includes('notfound')) {
        code = 'AWS_BEDROCK_MODEL_ERROR';
        statusCode = 502;
        publicMessage =
          'Configured Bedrock foundation model is unavailable or invalid.';
      } else if (errText.includes('throttl') || errText.includes('rate')) {
        code = 'AWS_BEDROCK_THROTTLED';
        statusCode = 429;
        publicMessage =
          'Request to Amazon Bedrock was rate-limited. Retry after backoff.';
      } else if (errText.includes('timeout') || errText.includes('abort')) {
        code = 'AGENT_TIMEOUT';
        statusCode = 504;
        publicMessage =
          'Agent invocation exceeded configured wall-clock timeout.';
      } else if (errText.includes('grounding')) {
        code = 'GROUNDING_VALIDATION_FAILED';
        statusCode = 422;
        publicMessage =
          'Brief failed grounding validation: one or more statements lacked authoritative evidence.';
      }

      return NextResponse.json(
        {
          success: false,
          error: publicMessage,
          code,
          meta: {
            modelId: result.modelId,
            latencyMs: result.latencyMs,
            stopReason: result.stopReason,
            grounding: {
              valid: result.grounding.valid,
              unsupportedEvidenceCount:
                result.grounding.unsupportedEvidenceCount,
            },
          },
        },
        { status: statusCode },
      );
    }

    const isActionProposalMode = result.brief?.mode === 'action_proposal';
    const hasProposedAction = Boolean(result.brief?.proposedAction);

    // Contradictory mode combinations fail closed
    if (!isActionProposalMode && hasProposedAction) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Invalid brief mode: proposedAction is only permitted in action_proposal mode.',
          code: 'INVALID_PROPOSAL_MODE',
        },
        { status: 400 },
      );
    }

    if (isActionProposalMode && !hasProposedAction) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Invalid brief: proposedAction is required in action_proposal mode.',
          code: 'INVALID_PROPOSAL_MODE',
        },
        { status: 400 },
      );
    }

    // Fail closed before constructing a write-capable action context.
    if (isActionProposalMode && !areWebActionWritesEnabled()) {
      return NextResponse.json(
        {
          success: false,
          error: 'Action proposals are disabled in the read-only demo.',
          code: 'ACTION_WRITES_DISABLED',
        },
        { status: 403 },
      );
    }

    let actionProposalMeta:
      | {
          proposalId: string;
          status: string;
          reviewUrl: string;
        }
      | undefined = undefined;

    if (isActionProposalMode && hasProposedAction) {
      if (!result.grounding?.valid) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Action proposal registration failed: grounding validation failed.',
            code: 'GROUNDING_VALIDATION_FAILED',
          },
          { status: 422 },
        );
      }

      if (!result.evidenceResolver) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Action proposal registration failed: authoritative evidence resolver is unavailable.',
            code: 'ACTION_PROPOSAL_REGISTRATION_FAILED',
          },
          { status: 422 },
        );
      }

      try {
        const actionCtx = getActionServerContext();
        const correlationId = `agent-run-${Date.now()}`;
        const registered = await registerActionProposal({
          tenant: actionCtx.tenant,
          modelInput: result.brief!.proposedAction!,
          correlationId,
          evidenceResolver:
            result.evidenceResolver as AuthoritativeEvidenceResolver,
          repositories: {
            clientRepository: actionCtx.dataStore.clients,
            projectRepository: actionCtx.dataStore.projects,
            actionProposalRepository: actionCtx.actionProposalRepository,
            auditEventRepository: actionCtx.auditEventRepository,
            userRepository: actionCtx.dataStore.users,
            milestoneRepository: actionCtx.dataStore.milestones,
          },
          transactionRunner: actionCtx.transactionRunner,
        });

        actionProposalMeta = {
          proposalId: registered.id,
          status: registered.status,
          reviewUrl: `/actions/${registered.id}`,
        };
      } catch (propErr: unknown) {
        // STRICT SECRET-SAFE BOUNDED LOGGING:
        // Never log propErr.message, propErr.stack, SQL queries, credentials, or URLs.
        console.error('[API /api/agent Proposal Registration Error]', {
          code: 'ACTION_PROPOSAL_REGISTRATION_FAILED',
          errorType: classifyProposalErrorType(propErr),
        });

        const statusCode =
          propErr instanceof ActionStoreUnavailableError ? 503 : 422;

        return NextResponse.json(
          {
            success: false,
            error:
              'Action proposal registration failed. Zero actions were persisted, approved, or executed.',
            code:
              propErr instanceof ActionStoreUnavailableError
                ? 'ACTION_STORE_UNAVAILABLE'
                : 'ACTION_PROPOSAL_REGISTRATION_FAILED',
          },
          { status: statusCode },
        );
      }
    }

    const publicData = {
      brief: result.brief,
      toolTrace: sanitizePublicToolTrace(result.toolTrace),
      modelId: result.modelId,
      stopReason: result.stopReason,
      latencyMs: result.latencyMs,
      tokenUsage: result.tokenUsage,
      grounding: {
        valid: result.grounding.valid,
        unsupportedEvidenceCount: result.grounding.unsupportedEvidenceCount,
      },
      ...(actionProposalMeta ? { actionProposal: actionProposalMeta } : {}),
    };

    return NextResponse.json({
      success: true,
      data: publicData,
    });
  } catch (error: unknown) {
    const err = error as Error;
    const errText = (err.message || String(error)).toLowerCase();

    let code = 'SERVER_ERROR';
    let statusCode = 500;
    let publicMessage =
      'An unexpected server error occurred during agent invocation.';

    if (errText.includes('econnrefused') || errText.includes('fetch failed')) {
      code = 'MCP_UNAVAILABLE';
      statusCode = 503;
      publicMessage =
        'ClientOps MCP service is currently unreachable. Ensure local service is running.';
    } else if (
      errText.includes('credential') ||
      errText.includes('accessdenied')
    ) {
      code = 'AWS_BEDROCK_AUTH_ERROR';
      statusCode = 503;
      publicMessage = 'Amazon Bedrock credentials unavailable or unauthorized.';
    }

    // Server-side bounded diagnostic metadata log only.
    // Strictly do NOT pass err.message, String(error), stack traces, raw provider responses,
    // filesystem paths, request bodies, credentials, tokens, or arbitrary exception objects.
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    console.error('[API /api/agent Error]', {
      code,
      errorType,
    });

    return NextResponse.json(
      {
        success: false,
        error: publicMessage,
        code,
      },
      { status: statusCode },
    );
  } finally {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // Suppress teardown error to avoid masking primary response
      }
    }
  }
}
