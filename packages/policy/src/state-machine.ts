import type { ActionStatus } from '@clientops/contracts';

/**
 * State Transition Error thrown on any illegal action proposal lifecycle transition.
 */
export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly currentStatus: ActionStatus,
    public readonly attemptedStatus: ActionStatus,
    message?: string,
  ) {
    super(
      message ??
        `Illegal action status transition from '${currentStatus}' to '${attemptedStatus}'. This transition violates the Phase 4 action state machine.`,
    );
    this.name = 'IllegalStateTransitionError';
  }
}

/**
 * Immutable transition map for the Phase 4 Action Lifecycle.
 *
 * Allowed transitions:
 * PROPOSED         → PENDING_APPROVAL | EXPIRED
 * PENDING_APPROVAL → APPROVED | DENIED | EXPIRED
 * APPROVED         → EXECUTING | EXPIRED
 * EXECUTING        → COMPLETED | FAILED
 *
 * Terminal states:
 * DENIED    → []
 * EXPIRED   → []
 * COMPLETED → []
 * FAILED    → []
 */
export const ALLOWED_STATE_TRANSITIONS: Readonly<
  Record<ActionStatus, readonly ActionStatus[]>
> = {
  PROPOSED: ['PENDING_APPROVAL', 'EXPIRED'],
  PENDING_APPROVAL: ['APPROVED', 'DENIED', 'EXPIRED'],
  APPROVED: ['EXECUTING', 'EXPIRED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  DENIED: [],
  EXPIRED: [],
  COMPLETED: [],
  FAILED: [],
};

/**
 * Checks whether transitioning from `currentStatus` to `nextStatus` is valid.
 */
export function canTransition(
  currentStatus: ActionStatus,
  nextStatus: ActionStatus,
): boolean {
  const allowed = ALLOWED_STATE_TRANSITIONS[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(nextStatus);
}

/**
 * Asserts that transitioning from `currentStatus` to `nextStatus` is legal.
 * Fails closed and throws `IllegalStateTransitionError` if the transition is prohibited.
 */
export function assertValidTransition(
  currentStatus: ActionStatus,
  nextStatus: ActionStatus,
): void {
  if (!canTransition(currentStatus, nextStatus)) {
    throw new IllegalStateTransitionError(currentStatus, nextStatus);
  }
}
