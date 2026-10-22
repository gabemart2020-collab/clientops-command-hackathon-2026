import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentInvocationResponseV1Schema,
  PHASE5_2_CERTIFICATION_MODEL_ID,
} from '@clientops/contracts';
import { parseAgentRuntimeServiceConfig } from './config.js';
import { closeHttpServer, createAgentRuntimeHttpServer } from './server.js';

const config = parseAgentRuntimeServiceConfig({
  host: '0.0.0.0',
  port: 8080,
  awsRegion: 'us-east-1',
  modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
  mcpRuntimeArn:
    'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/clientops_mcp_example-EXAMPLE123',
  mcpQualifier: 'DEFAULT',
  certificationOrganizationId: '10000000-0000-4000-8000-000000000001',
  certificationActorId: '10000000-0000-4000-8000-000000000011',
  maxBodyBytes: 512,
  maxTurns: 6,
  maxOutputTokens: 2000,
  maxTotalTokens: 12_000,
  timeoutMs: 30_000,
  temperature: 0.1,
});

const openServers: ReturnType<typeof createAgentRuntimeHttpServer>[] = [];

async function startServer() {
  const server = createAgentRuntimeHttpServer(config, async (input) => {
    const request = input as { requestId: string };
    return {
      statusCode: 200,
      body: AgentInvocationResponseV1Schema.parse({
        version: '1',
        requestId: request.requestId,
        success: true,
        data: {
          brief: {
            mode: 'capability_refusal',
            refusalReason: 'No write authority.',
            answer: 'The requested action was not executed.',
            findings: [],
            suggestedNextSteps: ['Use the trusted approval workflow.'],
          },
          toolTrace: [],
          modelId: PHASE5_2_CERTIFICATION_MODEL_ID,
          stopReason: 'end_turn',
          latencyMs: 1,
          grounding: {
            valid: true,
            unsupportedEvidenceCount: 0,
          },
        },
      }),
    };
  });
  openServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server?.listening) await closeHttpServer(server);
  }
});

describe('Phase 5.2.1 Agent Runtime HTTP boundary', () => {
  it('serves the AgentCore-compatible health contract', async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'Healthy' });
  });

  it('rejects browser-origin invocation before handler execution', async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/invocations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_INVOCATION');
  });

  it('returns strict V1 SERVER_ERROR when the invocation handler throws', async () => {
    const server = createAgentRuntimeHttpServer(config, async () => {
      throw new Error('sensitive internal failure');
    });
    openServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/invocations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'malformed host value',
        },
        body: JSON.stringify({
          version: '1',
          requestId: '11111111-1111-4111-8111-111111111111',
          sessionId: '22222222-2222-4222-8222-222222222222',
          organizationId: '10000000-0000-4000-8000-000000000001',
          actorId: '10000000-0000-4000-8000-000000000011',
          userMessage: 'Prepare the Acme review brief.',
        }),
      },
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      success: boolean;
      code: string;
      error: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('SERVER_ERROR');
    expect(JSON.stringify(body)).not.toContain('sensitive internal failure');
  });

  it('rejects oversized invocation bodies', async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(2000) }),
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('INVALID_INVOCATION');
  });
});
