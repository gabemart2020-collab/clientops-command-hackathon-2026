import { createServer, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  MCP_PROTOCOL_BASELINE,
  readConfig,
  type ServiceConfig,
} from './config.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { createProtocolServer, SERVICE, VERSION } from './protocol.js';
import {
  createClientOpsServer,
  getConfiguredClientOpsService,
} from './clientops.js';
import type { TenantContext, ClientOpsService } from '@clientops/domain';

export { createClientOpsServer } from './clientops.js';
export {
  readConfig,
  MCP_PROTOCOL_BASELINE,
  type ServiceConfig,
} from './config.js';

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** A fresh SDK server per HTTP exchange; no sessions or application storage. */
export async function startService(
  config: ServiceConfig = readConfig(),
  serverFactory: () => McpServer = createProtocolServer,
) {
  const handler = createMcpHandler(serverFactory, {
    legacy: 'stateless',
    maxRequestBodySize: 64 * 1024,
    maxSubscriptions: 0,
  });
  const mcp = toNodeHandler(handler, { maxRequestBodySize: 64 * 1024 });
  const validHost =
    config.runtimeMode === 'local'
      ? hostHeaderValidation(config.allowedHosts)
      : undefined;
  const validOrigin =
    config.runtimeMode === 'local'
      ? originValidation(
          config.allowedOrigins.map((value) => new URL(value).hostname),
        )
      : undefined;

  const http = createServer((req, res) => {
    const origin = req.headers.origin;

    if (config.runtimeMode === 'local') {
      if (!validHost?.(req, res) || !validOrigin?.(req, res)) return;

      // The SDK's Origin guard is hostname-only. Require the exact scheme,
      // hostname and port too.
      if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
        json(res, 403, { error: 'Forbidden origin' });
        return;
      }
    } else if (origin !== undefined) {
      // AgentCore MCP ingress is machine-to-machine only. Platform IAM/SigV4
      // protects ingress; browser-origin requests are rejected by the app.
      json(res, 403, { error: 'Browser origin not allowed' });
      return;
    }
    const path = req.url?.split('?')[0];
    if (path === '/mcp') {
      // CORS only for the exact validated browser origin; never a wildcard.
      if (origin !== undefined) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, GET, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version',
        });
        res.end();
        return;
      }
      // Project Node's optional fields explicitly for the SDK's exact-optional types.
      const incoming = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        [Symbol.asyncIterator]: () => req[Symbol.asyncIterator](),
      };
      void mcp(incoming, res).catch(() => {
        if (!res.headersSent)
          json(res, 500, { error: 'Internal server error' });
        else res.destroy();
      });
      return;
    }
    if (path === '/health' || path === '/version') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        json(res, 405, { error: 'Method not allowed' });
        return;
      }
      json(
        res,
        200,
        path === '/health'
          ? { status: 'ok' }
          : {
              service: SERVICE,
              version: VERSION,
              mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
              environment: config.environment,
            },
      );
      return;
    }
    json(res, 404, { error: 'Not found' });
  });
  http.requestTimeout = 10_000;
  http.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.port, config.bindHost, () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = http.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected TCP listener');
  const hostname =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostname}:${address.port}`,
    address,
    async close() {
      const stopped = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await handler.close();
      http.closeAllConnections();
      await stopped;
    },
  };
}

export async function startClientOpsService(
  config: ServiceConfig = readConfig(),
  tenant?: TenantContext,
  service?: ClientOpsService,
) {
  const resolvedService = service ?? (await getConfiguredClientOpsService());
  return startService(config, () =>
    createClientOpsServer(tenant, resolvedService),
  );
}
