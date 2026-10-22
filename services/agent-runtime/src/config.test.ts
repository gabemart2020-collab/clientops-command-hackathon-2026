import { describe, expect, it } from 'vitest';
import {
  loadAgentRuntimeServiceConfig,
  parseAgentRuntimeServiceConfig,
} from './config.js';

describe('Phase 5.2.1 runtime configuration', () => {
  it('loads the exact frozen HTTP/model/certification contract', () => {
    const config = loadAgentRuntimeServiceConfig({
      AWS_REGION: 'us-east-1',
      BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
      CLIENTOPS_AGENT_MCP_RUNTIME_ARN:
        'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/clientops_mcp_example-EXAMPLE123',
      CLIENTOPS_CERTIFICATION_ORGANIZATION_ID:
        '10000000-0000-4000-8000-000000000001',
      CLIENTOPS_CERTIFICATION_ACTOR_ID: '10000000-0000-4000-8000-000000000011',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.modelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(config.maxBodyBytes).toBe(65_536);
  });

  it('rejects model drift and malformed runtime ARN', () => {
    expect(() =>
      parseAgentRuntimeServiceConfig({
        host: '0.0.0.0',
        port: 8080,
        awsRegion: 'us-east-1',
        modelId: 'unexpected-model' as 'us.anthropic.claude-sonnet-4-6',
        mcpRuntimeArn: 'not-an-arn',
        mcpQualifier: 'DEFAULT',
        certificationOrganizationId: '10000000-0000-4000-8000-000000000001',
        certificationActorId: '10000000-0000-4000-8000-000000000011',
        maxBodyBytes: 65_536,
        maxTurns: 6,
        maxOutputTokens: 2000,
        maxTotalTokens: 12_000,
        timeoutMs: 30_000,
        temperature: 0.1,
      }),
    ).toThrow();
  });
});
