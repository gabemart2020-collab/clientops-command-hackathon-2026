import { NextResponse } from 'next/server';
import {
  getProposalForReview,
  resolveTrustedActor,
  SecurityBoundaryViolationError,
  assertAuthoritativeApproverRole,
  UnauthorizedApproverError,
} from '@clientops/policy';
import type { TrustedActorContext } from '@clientops/contracts';
import {
  getActionServerContext,
  ActionStoreUnavailableError,
} from '@/lib/action-context';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  const resolvedParams = await context.params;
  const proposalId = resolvedParams.proposalId;

  if (!proposalId || !UUID_REGEX.test(proposalId)) {
    return NextResponse.json(
      {
        error: 'INVALID_PROPOSAL_ID',
        message: 'Proposal identifier must be a valid UUID.',
      },
      { status: 400 },
    );
  }

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

  // Resolve trusted actor server-side (fails closed outside test/dev with opt-in)
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

  // Verify authoritative database user has admin or operator role and matches actor role
  try {
    await assertAuthoritativeApproverRole(
      actionCtx.tenant,
      actor,
      actionCtx.dataStore.users,
    );
  } catch (err: unknown) {
    if (err instanceof UnauthorizedApproverError) {
      return NextResponse.json(
        {
          error: 'FORBIDDEN',
          message: 'Actor is not authorized to review action proposals.',
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }

  try {
    const reviewData = await getProposalForReview(
      actionCtx.tenant,
      proposalId,
      {
        actionProposalRepository: actionCtx.actionProposalRepository,
        clientRepository: actionCtx.dataStore.clients,
        projectRepository: actionCtx.dataStore.projects,
        userRepository: actionCtx.dataStore.users,
        milestoneRepository: actionCtx.dataStore.milestones,
      },
    );

    if (!reviewData) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Action proposal not found.' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: reviewData,
    });
  } catch {
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}
