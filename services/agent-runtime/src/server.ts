import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { AgentInvocationFailureV1Schema } from '@clientops/contracts';
import type { AgentRuntimeHttpResult } from './handler.js';
import type { AgentRuntimeServiceConfig } from './config.js';

export type AgentRuntimeInvocationHandler = (
  rawInput: unknown,
) => Promise<AgentRuntimeHttpResult>;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function invalidInvocation(message: string) {
  return AgentInvocationFailureV1Schema.parse({
    version: '1',
    requestId: randomUUID(),
    success: false,
    code: 'INVALID_INVOCATION',
    error: message,
  });
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    throw new Error('INVALID_JSON');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

export function createAgentRuntimeHttpServer(
  config: AgentRuntimeServiceConfig,
  handler: AgentRuntimeInvocationHandler,
) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/ping') {
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }

      if (request.method !== 'POST' || url.pathname !== '/invocations') {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }

      if (request.headers.origin) {
        sendJson(
          response,
          403,
          invalidInvocation('Browser-origin invocation is prohibited.'),
        );
        return;
      }

      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        sendJson(
          response,
          415,
          invalidInvocation('Content-Type must be application/json.'),
        );
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request, config.maxBodyBytes);
      } catch (error: unknown) {
        const tooLarge =
          error instanceof Error && error.message === 'BODY_TOO_LARGE';
        sendJson(
          response,
          tooLarge ? 413 : 400,
          invalidInvocation(
            tooLarge
              ? 'Invocation body exceeds the configured size limit.'
              : 'Invocation body must contain valid JSON.',
          ),
        );
        return;
      }

      const result = await handler(body);
      sendJson(response, result.statusCode, result.body);
    } catch {
      sendJson(
        response,
        500,
        AgentInvocationFailureV1Schema.parse({
          version: '1',
          requestId: randomUUID(),
          success: false,
          code: 'SERVER_ERROR',
          error: 'Agent Runtime HTTP boundary failed safely.',
        }),
      );
    }
  });
}

export async function closeHttpServer(
  server: ReturnType<typeof createAgentRuntimeHttpServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
