import { describe, expect, it } from 'vitest';

import {
  assertRestrictedRuntimePolicy,
  type Policy,
  type Statement,
} from './iam-policy-guardrails.js';

import {
  AGENT_RUNTIME_SENSITIVE_ACTIONS,
  EXAMPLE_MCP_RUNTIME_ARN,
  PROPOSER_SECRET_ARN_PLACEHOLDER,
  agentRuntimeSensitiveBoundary,
  agentRuntimeSensitivePolicyCandidate,
} from './iam-policy-candidate.js';

const INVOKE = AGENT_RUNTIME_SENSITIVE_ACTIONS.invokeMcp;
const READ_SECRET = AGENT_RUNTIME_SENSITIVE_ACTIONS.readProposerSecret;
const MCP_ARN = EXAMPLE_MCP_RUNTIME_ARN;
const PROPOSER_SECRET_ARN = PROPOSER_SECRET_ARN_PLACEHOLDER;
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

function candidate(action: string, resource: string): Policy {
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: INVOKE, Resource: MCP_ARN },
      {
        Effect: 'Allow',
        Action: READ_SECRET,
        Resource: PROPOSER_SECRET_ARN,
      },
      { Effect: 'Allow', Action: action, Resource: resource },
    ],
  };
}

describe('Phase 5.2.3-A IAM boundary (offline negative tests)', () => {
  it('accepts the version-controlled offline policy candidate', () => {
    expect(() =>
      assertRestrictedRuntimePolicy(
        agentRuntimeSensitivePolicyCandidate,
        agentRuntimeSensitiveBoundary,
      ),
    ).not.toThrow();
  });

  it.each([
    [INVOKE, '*'],
    [INVOKE, `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:runtime/*`],
    [READ_SECRET, '*'],
    [READ_SECRET, `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:*`],
    ['bedrock-agentcore:InvokeAgentRuntimeForUser', MCP_ARN],
    ['secretsmanager:ListSecrets', '*'],
    ['iam:PassRole', '*'],
    ['iam:CreateRole', '*'],
    ['bedrock-agentcore:DeleteAgentRuntime', '*'],
    ['*', '*'],
  ])('rejects extra permission %s on %s', (action, resource) => {
    expect(() =>
      assertRestrictedRuntimePolicy(
        candidate(action, resource),
        agentRuntimeSensitiveBoundary,
      ),
    ).toThrow();
  });

  it('rejects NotAction and NotResource allowlist bypasses', () => {
    for (const field of ['NotAction', 'NotResource']) {
      const policy = candidate(INVOKE, MCP_ARN);
      const statement = (policy.Statement as Statement[])[0];
      if (!statement) throw new Error('Missing test statement');
      statement[field as 'NotAction' | 'NotResource'] = '*';

      expect(() =>
        assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
      ).toThrow();
    }
  });

  it('rejects missing required permission', () => {
    expect(() =>
      assertRestrictedRuntimePolicy(
        {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: INVOKE, Resource: MCP_ARN }],
        },
        agentRuntimeSensitiveBoundary,
      ),
    ).toThrow();
  });

  it('rejects malformed and unsupported policy structures', () => {
    for (const policy of [
      {},
      { Version: '2008-10-17', Statement: [] },
      { Version: '2012-10-17', Statement: [null] },
      {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
      },
    ]) {
      expect(() =>
        assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
      ).toThrow();
    }
  });
});

describe('Phase 5.2.3-A independent resource-contract assertions', () => {
  it('pins the approved action strings independently', () => {
    expect(INVOKE).toBe('bedrock-agentcore:InvokeAgentRuntime');
    expect(READ_SECRET).toBe('secretsmanager:GetSecretValue');
  });

  it('pins the synthetic example MCP runtime ARN independently', () => {
    expect(MCP_ARN).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:' +
        'runtime/clientops_mcp_example-EXAMPLE123',
    );
  });

  it('pins the synthetic proposer-secret placeholder independently', () => {
    expect(PROPOSER_SECRET_ARN).toBe(
      'arn:aws:secretsmanager:us-east-1:111122223333:' +
        'secret:clientops-command/phase5-2/staging/' +
        'agent-proposer-database-url-EXAMPLE',
    );

    expect(PROPOSER_SECRET_ARN.endsWith('-EXAMPLE')).toBe(true);
  });

  it('rejects unexpected top-level policy fields', () => {
    for (const field of ['Id', 'Principal', 'NotPrincipal', 'Condition']) {
      const policy = {
        ...agentRuntimeSensitivePolicyCandidate,
        [field]: 'unexpected',
      };

      expect(() =>
        assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
      ).toThrow();
    }
  });

  it('rejects unexpected statement fields', () => {
    for (const field of [
      'Sid',
      'Principal',
      'NotPrincipal',
      'Condition',
      'NotAction',
      'NotResource',
      'UnexpectedField',
    ]) {
      const policy: Policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: INVOKE,
            Resource: MCP_ARN,
            [field]: 'unexpected',
          },
          {
            Effect: 'Allow',
            Action: READ_SECRET,
            Resource: PROPOSER_SECRET_ARN,
          },
        ],
      };

      expect(() =>
        assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
      ).toThrow();
    }
  });

  it('rejects malformed actions and resources', () => {
    const invalidValues: unknown[] = [
      '',
      ' ',
      [''],
      [' '],
      [],
      [INVOKE, INVOKE],
      [MCP_ARN, MCP_ARN],
      [null],
      [123],
      123,
      {},
    ];

    for (const invalid of invalidValues) {
      for (const field of ['Action', 'Resource'] as const) {
        const policy: Policy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: INVOKE,
              Resource: MCP_ARN,
              [field]: invalid,
            },
            {
              Effect: 'Allow',
              Action: READ_SECRET,
              Resource: PROPOSER_SECRET_ARN,
            },
          ],
        };

        expect(() =>
          assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
        ).toThrow();
      }
    }
  });

  it('rejects a statement with an unsupported effect', () => {
    for (const effect of ['Deny', '', null, true]) {
      const policy: Policy = {
        Version: '2012-10-17',
        Statement: [
          { Effect: effect, Action: INVOKE, Resource: MCP_ARN },
          {
            Effect: 'Allow',
            Action: READ_SECRET,
            Resource: PROPOSER_SECRET_ARN,
          },
        ],
      };

      expect(() =>
        assertRestrictedRuntimePolicy(policy, agentRuntimeSensitiveBoundary),
      ).toThrow();
    }
  });
});
