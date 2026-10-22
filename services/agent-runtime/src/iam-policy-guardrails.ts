export type Statement = {
  Effect?: unknown;
  Action?: unknown;
  NotAction?: unknown;
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: unknown;
};

export type Policy = {
  Version?: unknown;
  Statement?: unknown;
};

const POLICY_KEYS = new Set(['Version', 'Statement']);
const STATEMENT_KEYS = new Set(['Effect', 'Action', 'Resource']);

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error('Unsupported IAM policy field');
    }
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return [];
}

/**
 * Conservative offline gate for the two sensitive runtime permissions.
 * This is NOT a complete IAM authorization evaluator.
 */
export function assertRestrictedRuntimePolicy(
  policy: Policy,
  expected: {
    allowedActions: readonly string[];
    resources: Readonly<Record<string, string>>;
  },
): void {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Malformed IAM policy');
  }

  assertExactKeys(policy as Record<string, unknown>, POLICY_KEYS);

  if (policy.Version !== '2012-10-17') {
    throw new Error('Unexpected IAM policy version');
  }

  if (!Array.isArray(policy.Statement) || policy.Statement.length === 0) {
    throw new Error('Missing IAM statements');
  }

  const covered = new Set<string>();

  for (const raw of policy.Statement) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Malformed IAM statement');
    }

    assertExactKeys(raw as Record<string, unknown>, STATEMENT_KEYS);

    const statement = raw as Statement;

    if (
      statement.Effect !== 'Allow' ||
      statement.NotAction !== undefined ||
      statement.NotResource !== undefined ||
      statement.Condition !== undefined
    ) {
      throw new Error('Unsupported IAM statement form');
    }

    const actions = strings(statement.Action);
    const resources = strings(statement.Resource);

    if (
      !actions.length ||
      !resources.length ||
      actions.some(
        (action) => action.length === 0 || action.trim() !== action,
      ) ||
      resources.some(
        (resource) => resource.length === 0 || resource.trim() !== resource,
      ) ||
      new Set(actions).size !== actions.length ||
      new Set(resources).size !== resources.length
    ) {
      throw new Error('Malformed actions or resources');
    }

    for (const action of actions) {
      if (!expected.allowedActions.includes(action)) {
        throw new Error('Unapproved IAM action');
      }

      const requiredResource = expected.resources[action];

      if (!requiredResource) {
        throw new Error('Action has no approved resource binding');
      }

      if (resources.length !== 1 || resources[0] !== requiredResource) {
        throw new Error('IAM resource exceeds approved scope');
      }

      covered.add(action);
    }
  }

  for (const action of expected.allowedActions) {
    if (!covered.has(action)) {
      throw new Error('Required permission missing');
    }
  }
}
