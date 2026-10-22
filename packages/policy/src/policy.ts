import type { ActionClass, PolicyDecision } from '@clientops/contracts';

/**
 * Authoritative mapping of known action types to ActionClass.
 */
export const ACTION_CLASSIFICATIONS: Readonly<Record<string, ActionClass>> = {
  // READ actions: retrieve domain state, zero mutation
  'system.get_status': 'READ',
  'account.get_context': 'READ',
  'activity.get_recent': 'READ',
  'commitment.list_open': 'READ',

  // ANALYZE actions: evaluate deterministic rules, derive evidence-backed insights, zero mutation
  'project.assess_delivery_health': 'ANALYZE',
  'meeting.prepare_brief': 'ANALYZE',

  // DRAFT actions: produce internal text draft, zero external side effects
  'client_update.draft': 'DRAFT',

  // WRITE actions: mutate business records, strictly require human approval
  'task.create': 'WRITE',

  // EXTERNAL actions: interact with external systems (email, slack, webhooks) - strictly out of scope
  'external.send_email': 'EXTERNAL',
  'external.slack_post': 'EXTERNAL',
  'external.webhook': 'EXTERNAL',

  // DESTRUCTIVE actions: delete/truncate/drop records, audit mutation - strictly out of scope
  'data.delete': 'DESTRUCTIVE',
  'data.drop': 'DESTRUCTIVE',
  'data.reset': 'DESTRUCTIVE',
  'audit.update': 'DESTRUCTIVE',
  'audit.delete': 'DESTRUCTIVE',
};

/**
 * Checks whether an action type is known in the authoritative registry.
 */
export function isKnownActionType(actionType: string): boolean {
  const normalized = actionType.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(
    ACTION_CLASSIFICATIONS,
    normalized,
  );
}

/**
 * Classifies an action type into its corresponding ActionClass.
 * Unknown actions are classified as 'EXTERNAL' (denied in v1).
 * Unknown actions are NEVER classified as 'WRITE' or allowed to request approval.
 */
export function classifyActionClass(actionType: string): ActionClass {
  const normalized = actionType.trim().toLowerCase();
  const direct = ACTION_CLASSIFICATIONS[normalized];
  if (direct) {
    return direct;
  }

  if (
    normalized.startsWith('data.delete') ||
    normalized.includes('drop') ||
    normalized.includes('truncate')
  ) {
    return 'DESTRUCTIVE';
  }

  // Fail closed: unrecognized actions default to EXTERNAL (denied by policy)
  // NEVER classify an unknown action as WRITE or permit REQUIRES_APPROVAL
  return 'EXTERNAL';
}

/**
 * Deterministically evaluates policy for an action type.
 *
 * Rules:
 * - Unknown action types: DENIED (never WRITE or REQUIRES_APPROVAL)
 * - READ / ANALYZE: AUTOMATIC_ALLOW (no business mutation)
 * - DRAFT: AUTOMATIC_ALLOW (internal text draft, no side effects)
 * - WRITE: REQUIRES_APPROVAL (mutates business records)
 * - EXTERNAL: DENIED (strictly out of scope in v1)
 * - DESTRUCTIVE: DENIED (strictly out of scope in v1)
 */
export function evaluatePolicy(actionType: string): PolicyDecision {
  const normalized = actionType.trim().toLowerCase();

  // Rule 2: Unknown action types MUST deterministically evaluate to DENIED.
  // Never classify an unknown action as WRITE or REQUIRES_APPROVAL.
  if (!isKnownActionType(normalized)) {
    return {
      decision: 'DENIED',
      actionType,
      actionClass: classifyActionClass(actionType),
      reason: `Unknown action type '${actionType}' is unauthorized. Unknown actions deterministically evaluate to DENIED.`,
    };
  }

  const actionClass = classifyActionClass(actionType);

  switch (actionClass) {
    case 'READ':
      return {
        decision: 'AUTOMATIC_ALLOW',
        actionType,
        actionClass,
        reason:
          'READ actions retrieve authorized domain state with zero business mutation and are automatically allowed.',
      };

    case 'ANALYZE':
      return {
        decision: 'AUTOMATIC_ALLOW',
        actionType,
        actionClass,
        reason:
          'ANALYZE actions deterministically derive evidence-backed insights with zero business mutation and are automatically allowed.',
      };

    case 'DRAFT':
      return {
        decision: 'AUTOMATIC_ALLOW',
        actionType,
        actionClass,
        reason:
          'DRAFT actions synthesize internal text content with no external side effects and are automatically allowed.',
      };

    case 'WRITE':
      return {
        decision: 'REQUIRES_APPROVAL',
        actionType,
        actionClass,
        reason:
          'WRITE actions mutate domain state and require deterministic server-side human approval bound to verified actor, tenant, parameters, and record versions.',
      };

    case 'EXTERNAL':
      return {
        decision: 'DENIED',
        actionType,
        actionClass,
        reason:
          'EXTERNAL actions (e.g. email, Slack, webhooks) are strictly outside v1 scope and denied.',
      };

    case 'DESTRUCTIVE':
      return {
        decision: 'DENIED',
        actionType,
        actionClass,
        reason:
          'DESTRUCTIVE actions (e.g. database deletes, resets, drops) are strictly outside v1 scope and denied.',
      };
  }
}
