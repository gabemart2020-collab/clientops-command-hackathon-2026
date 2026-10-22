import { NextResponse } from 'next/server';
import {
  ApprovalDecisionRequestSchema,
  type TrustedActorContext,
} from '@clientops/contracts';
import {
  resolveApprovalDecision,
  resolveTrustedActor,
  executeApprovedAction,
  type ExecuteApprovedActionResult,
  SecurityBoundaryViolationError,
  ProposalNotFoundError,
  ConflictError,
  ProposalExpiredError,
  UnauthorizedApproverError,
  ProposalTamperedError,
  InvalidProposalStatusError,
  PreconditionFailedError,
} from '@clientops/policy';
import {
  getActionServerContext,
  ActionStoreUnavailableError,
} from '@/lib/action-context';
import { areWebActionWritesEnabled } from '@/lib/web-action-write-gate';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  // Reject before parsing or resolving an actor: no approval, denial or execution.
  if (!areWebActionWritesEnabled()) {
    return NextResponse.json(
      {
        error: 'ACTION_WRITES_DISABLED',
        message:
          'Action decisions and execution are disabled in the read-only demo.',
      },
      { status: 403 },
    );
  }

  const resolvedParams = await context.params;
  const proposalId = resolvedParams.proposalId;

  // 1. Validate proposalId format
  if (!proposalId || !UUID_REGEX.test(proposalId)) {
    return NextResponse.json(
      {
        error: 'INVALID_PROPOSAL_ID',
        message: 'Proposal identifier must be a valid UUID.',
      },
      { status: 400 },
    );
  }

  // 2. Exact same-origin / CSRF verification
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin') {
    return NextResponse.json(
      {
        error: 'FORBIDDEN',
        message: 'Cross-site decision requests are prohibited.',
      },
      { status: 403 },
    );
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'Invalid request URL.' },
      { status: 400 },
    );
  }

  const originHeader = request.headers.get('origin');
  if (originHeader) {
    try {
      const parsedOrigin = new URL(originHeader).origin;
      if (parsedOrigin !== requestOrigin) {
        return NextResponse.json(
          {
            error: 'FORBIDDEN',
            message: 'Cross-origin decision requests are prohibited.',
          },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Invalid origin header.' },
        { status: 403 },
      );
    }
  } else if (secFetchSite !== 'same-origin') {
    return NextResponse.json(
      {
        error: 'FORBIDDEN',
        message: 'Same-origin decision verification failed.',
      },
      { status: 403 },
    );
  }

  // 3. Payload size bound (16 KB max)
  const rawBody = await request.text().catch(() => '');
  if (rawBody.length > 16384) {
    return NextResponse.json(
      {
        error: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds maximum size.',
      },
      { status: 413 },
    );
  }

  // 4. Parse JSON safely
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  // 5. Strict schema validation (rejects extra/trusted fields)
  const parseResult = ApprovalDecisionRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: 'VALIDATION_FAILED',
        message: 'Invalid decision request parameters.',
      },
      { status: 400 },
    );
  }

  // 6. Get server context
  let actionCtx;
  try {
    actionCtx = getActionServerContext();
  } catch (err: unknown) {
    if (err instanceof ActionStoreUnavailableError) {
      return NextResponse.json(
        {
          error: 'ACTION_STORE_UNAVAILABLE',
          message: 'Durable action store is currently unavailable.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }

  // 7. Resolve trusted actor (fails closed outside test/dev with opt-in)
  let actor: TrustedActorContext;
  try {
    actor = resolveTrustedActor(actionCtx.tenant);
  } catch (err: unknown) {
    if (err instanceof SecurityBoundaryViolationError) {
      return NextResponse.json(
        {
          error: 'UNAUTHORIZED_ENVIRONMENT',
          message: 'Actor resolution is prohibited in this environment.',
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Failed to resolve trusted actor.' },
      { status: 403 },
    );
  }

  // 8. Execute atomic decision resolution
  try {
    const result = await resolveApprovalDecision({
      tenant: actionCtx.tenant,
      proposalId,
      request: parseResult.data,
      actor,
      repositories: {
        actionProposalRepository: actionCtx.actionProposalRepository,
        actionApprovalRepository: actionCtx.actionApprovalRepository,
        auditEventRepository: actionCtx.auditEventRepository,
        userRepository: actionCtx.dataStore.users,
        clientRepository: actionCtx.dataStore.clients,
        projectRepository: actionCtx.dataStore.projects,
      },
      transactionRunner: actionCtx.transactionRunner,
    });

    // 9. If decision is DENY: do not invoke executor
    if (result.approval.decision === 'DENY') {
      return NextResponse.json({
        success: true,
        data: {
          proposalId: result.proposal.id,
          status: result.proposal.status,
          decision: result.approval.decision,
          decidedAt: result.approval.decidedAt,
          idempotent: result.idempotent,
        },
      });
    }

    // 10. If decision is APPROVE: invoke trusted executor
    let executionResult: ExecuteApprovedActionResult | null = null;
    let blockedCode: string | null = null;
    let blockedMessage: string | null = null;
    let executionUnconfirmed = false;

    try {
      executionResult = await executeApprovedAction({
        tenant: actionCtx.tenant,
        proposalId,
        repositories: {
          actionProposalRepository: actionCtx.actionProposalRepository,
          actionApprovalRepository: actionCtx.actionApprovalRepository,
          actionExecutionRepository: actionCtx.actionExecutionRepository,
          auditEventRepository: actionCtx.auditEventRepository,
          controlledTaskMutationRepository:
            actionCtx.controlledTaskMutationRepository,
          userRepository: actionCtx.dataStore.users,
          projectRepository: actionCtx.dataStore.projects,
          milestoneRepository: actionCtx.dataStore.milestones,
        },
        transactionRunner: actionCtx.transactionRunner,
      });
    } catch (execErr: unknown) {
      if (execErr instanceof ProposalTamperedError) {
        blockedCode = 'TAMPER_DETECTED';
        blockedMessage =
          'Proposal integrity verification failed prior to execution.';
      } else if (execErr instanceof UnauthorizedApproverError) {
        blockedCode = 'AUTHORIZATION_REVOKED';
        blockedMessage =
          'Approver authorization is no longer valid for execution.';
      } else if (execErr instanceof PreconditionFailedError) {
        blockedCode = 'PRECONDITION_FAILED';
        blockedMessage =
          'Execution preconditions are no longer satisfied. No task was created.';
      } else if (execErr instanceof InvalidProposalStatusError) {
        blockedCode = 'INVALID_STATUS';
        blockedMessage = 'Proposal status does not permit execution.';
      } else if (execErr instanceof ConflictError) {
        blockedCode = 'INTEGRITY_CONFLICT';
        blockedMessage =
          'Durable execution state is inconsistent or already in progress. No new task was created.';
      } else {
        executionUnconfirmed = true;
      }
    }

    if (blockedCode) {
      return NextResponse.json({
        success: true,
        data: {
          proposalId: result.proposal.id,
          status: result.proposal.status,
          decision: 'APPROVE',
          decidedAt: result.approval.decidedAt,
          idempotent: result.idempotent,
          execution: {
            status: 'BLOCKED',
            code: blockedCode,
            message: blockedMessage,
          },
        },
      });
    }

    if (executionUnconfirmed || !executionResult) {
      return NextResponse.json({
        success: true,
        data: {
          proposalId: result.proposal.id,
          status: 'APPROVED',
          decision: 'APPROVE',
          decidedAt: result.approval.decidedAt,
          idempotent: result.idempotent,
          execution: {
            status: 'UNCONFIRMED',
            message:
              'Approval recorded, but execution outcome could not be confirmed. Safe to retry.',
          },
        },
      });
    }

    if (executionResult.status === 'EXPIRED') {
      return NextResponse.json({
        success: true,
        data: {
          proposalId: result.proposal.id,
          status: executionResult.proposal.status,
          decision: 'APPROVE',
          decidedAt: result.approval.decidedAt,
          idempotent: result.idempotent,
          execution: {
            status: 'EXPIRED',
            reason: executionResult.reason,
            message:
              executionResult.reason === 'APPROVAL_EXPIRED'
                ? 'Approval validity period expired prior to execution.'
                : 'Proposal expiration deadline passed prior to execution.',
          },
        },
      });
    }

    if (executionResult.status === 'COMPLETED') {
      return NextResponse.json({
        success: true,
        data: {
          proposalId: result.proposal.id,
          status: executionResult.proposal.status,
          decision: 'APPROVE',
          decidedAt: result.approval.decidedAt,
          idempotent: result.idempotent,
          execution: {
            status: 'COMPLETED',
            executionId: executionResult.execution.id,
            completedAt: executionResult.execution.completedAt,
            task: {
              id: executionResult.task.id,
              title: executionResult.task.title,
              status: executionResult.task.status,
              projectId: executionResult.task.projectId,
              priority: executionResult.task.priority,
            },
          },
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        proposalId: result.proposal.id,
        status: executionResult.proposal.status,
        decision: 'APPROVE',
        decidedAt: result.approval.decidedAt,
        idempotent: result.idempotent,
        execution: {
          status: 'FAILED',
          executionId: executionResult.execution.id,
          errorCode: executionResult.errorCode,
          failureSummary: executionResult.failureSummary,
        },
      },
    });
  } catch (error: unknown) {
    if (error instanceof ProposalNotFoundError) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Action proposal not found.' },
        { status: 404 },
      );
    }
    if (error instanceof ConflictError) {
      return NextResponse.json(
        { error: 'CONFLICT', message: 'Conflict resolving proposal decision.' },
        { status: 409 },
      );
    }
    if (error instanceof ProposalExpiredError) {
      return NextResponse.json(
        {
          error: 'PROPOSAL_EXPIRED',
          message: 'Action proposal has expired.',
        },
        { status: 410 },
      );
    }
    if (error instanceof UnauthorizedApproverError) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Approver is not authorized.' },
        { status: 403 },
      );
    }
    if (error instanceof ProposalTamperedError) {
      return NextResponse.json(
        {
          error: 'TAMPER_DETECTED',
          message: 'Proposal integrity verification failed.',
        },
        { status: 400 },
      );
    }
    if (error instanceof InvalidProposalStatusError) {
      return NextResponse.json(
        {
          error: 'INVALID_STATUS',
          message: 'Proposal is not in pending approval status.',
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}
