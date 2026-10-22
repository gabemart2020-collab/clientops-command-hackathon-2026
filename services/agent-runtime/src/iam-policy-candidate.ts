import type { Policy } from './iam-policy-guardrails.js';

/**
 * Phase 5.2.3-A offline IAM policy candidate.
 *
 * NOT DEPLOYABLE.
 *
 * Covers only the sensitive AgentCore invocation and proposer-secret
 * read boundaries. Other permissions, IAM trust policy, AWS action/resource
 * support, conditions, and exact secret ARN must be independently verified.
 */

// Synthetic AWS documentation account; this policy candidate is NOT deployable.
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

export const EXAMPLE_MCP_RUNTIME_ARN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:runtime/` +
  'clientops_mcp_example-EXAMPLE123';

export const PROPOSER_SECRET_ARN_PLACEHOLDER =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:` +
  'clientops-command/phase5-2/staging/agent-proposer-database-url-EXAMPLE';

export const AGENT_RUNTIME_SENSITIVE_ACTIONS = {
  invokeMcp: 'bedrock-agentcore:InvokeAgentRuntime',
  readProposerSecret: 'secretsmanager:GetSecretValue',
} as const;

export const agentRuntimeSensitiveBoundary = {
  allowedActions: [
    AGENT_RUNTIME_SENSITIVE_ACTIONS.invokeMcp,
    AGENT_RUNTIME_SENSITIVE_ACTIONS.readProposerSecret,
  ],
  resources: {
    [AGENT_RUNTIME_SENSITIVE_ACTIONS.invokeMcp]: EXAMPLE_MCP_RUNTIME_ARN,
    [AGENT_RUNTIME_SENSITIVE_ACTIONS.readProposerSecret]:
      PROPOSER_SECRET_ARN_PLACEHOLDER,
  },
} as const;

export const agentRuntimeSensitivePolicyCandidate: Policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: AGENT_RUNTIME_SENSITIVE_ACTIONS.invokeMcp,
      Resource: EXAMPLE_MCP_RUNTIME_ARN,
    },
    {
      Effect: 'Allow',
      Action: AGENT_RUNTIME_SENSITIVE_ACTIONS.readProposerSecret,
      Resource: PROPOSER_SECRET_ARN_PLACEHOLDER,
    },
  ],
};
