import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { readConfig, MCP_PROTOCOL_BASELINE } from './config.js';
import { startService } from './index.js';
import { SERVICE, VERSION, STATUS_TOOL, statusSchema } from './protocol.js';

let service: Awaited<ReturnType<typeof startService>>;
const baselineHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': MCP_PROTOCOL_BASELINE,
};
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_BASELINE,
    capabilities: {},
    clientInfo: { name: 'proof-test', version: '1.0.0' },
  },
};
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

// Use node:http so Host tests send the exact header, independent of fetch restrictions.
async function http(
  path: string,
  method = 'GET',
  body?: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    text: string;
  }>((resolve, reject) => {
    const req = request(
      new URL(path, service.url),
      { method, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function message(text: string) {
  if (text.startsWith('{')) return JSON.parse(text);
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter(Boolean);
  return JSON.parse(data.at(-1) ?? 'null');
}
const post = (body: unknown, extra: Record<string, string> = {}) =>
  http('/mcp', 'POST', JSON.stringify(body), { ...baselineHeaders, ...extra });

beforeAll(async () => {
  service = await startService(readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }));
});
afterAll(async () => {
  await service?.close();
});

describe('official MCP client over real Streamable HTTP', () => {
  it('negotiates exactly 2025-11-25, initializes, discovers and invokes the only tool', async () => {
    const exchanges: {
      method: string;
      version: string | null;
      body: ReturnType<typeof message>;
      response: ReturnType<typeof message>;
      status: number;
    }[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(`${service.url}/mcp`),
      {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          const body =
            req.method === 'POST'
              ? JSON.parse(await req.clone().text())
              : undefined;
          const response = await fetch(req);
          if (body) {
            const text = await response.clone().text();
            exchanges.push({
              method: body.method,
              version: req.headers.get('MCP-Protocol-Version'),
              body,
              response: text ? message(text) : null,
              status: response.status,
            });
          }
          return response;
        },
      },
    );
    const client = new Client(
      { name: 'clientops-protocol-test', version: '1.0.0' },
      {
        supportedProtocolVersions: [MCP_PROTOCOL_BASELINE],
        versionNegotiation: { mode: 'legacy' },
      },
    );
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('legacy');
      expect(transport.protocolVersion).toBe(MCP_PROTOCOL_BASELINE);
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerVersion()).toMatchObject({
        name: SERVICE,
        version: VERSION,
      });
      const discovery = await client.listTools();
      expect(discovery.tools.map((tool) => tool.name)).toEqual([STATUS_TOOL]);
      expect(discovery.tools[0]?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(discovery.tools[0]?.outputSchema).toMatchObject({
        type: 'object',
      });
      const result = await client.callTool({
        name: STATUS_TOOL,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const status = statusSchema.parse(result.structuredContent);
      expect(status).toEqual({
        service: SERVICE,
        version: VERSION,
        status: 'ok',
        mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
        runtime: 'nodejs-24',
      });
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(status) },
      ]);
      const opening = exchanges.find(
        (exchange) => exchange.method === 'initialize',
      );
      expect(opening?.body.params.protocolVersion).toBe(MCP_PROTOCOL_BASELINE);
      expect(opening?.response.result.protocolVersion).toBe(
        MCP_PROTOCOL_BASELINE,
      );
      expect(opening?.status).toBe(200);
      expect(
        exchanges.find(
          (exchange) => exchange.method === 'notifications/initialized',
        )?.status,
      ).toBe(202);
      for (const method of [
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ]) {
        expect(
          exchanges.find((exchange) => exchange.method === method)?.version,
        ).toBe(MCP_PROTOCOL_BASELINE);
      }
      expect(
        exchanges.some((exchange) => exchange.method === 'server/discover'),
      ).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('HTTP protocol semantics', () => {
  it('serves raw initialization and independent requests without a session ID', async () => {
    const response = await post(initialize);
    expect(response.status).toBe(200);
    expect(message(response.text).result.protocolVersion).toBe(
      MCP_PROTOCOL_BASELINE,
    );
    expect(response.headers['mcp-session-id']).toBeUndefined();
    expect(response.headers['content-type']).toContain('text/event-stream');
    const discovered = await post(list);
    expect(discovered.status).toBe(200);
    expect(
      message(discovered.text).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual([STATUS_TOOL]);
  });

  it.each(['GET', 'DELETE'])(
    'returns SDK 405 for stateless %s /mcp',
    async (method) => {
      const response = await http('/mcp', method, undefined, baselineHeaders);
      expect(response.status).toBe(405);
    },
  );

  it.each([
    [
      'wrong Content-Type',
      JSON.stringify(list),
      { 'Content-Type': 'text/plain' },
      415,
      -32000,
    ],
    ['malformed JSON', '{', {}, 400, -32700],
    [
      'invalid JSON-RPC',
      JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tools/list' }),
      {},
      400,
      -32600,
    ],
    [
      'missing Accept types',
      JSON.stringify(list),
      { Accept: 'application/json' },
      406,
      -32000,
    ],
    [
      'unsupported protocol header',
      JSON.stringify(list),
      { 'MCP-Protocol-Version': '1900-01-01' },
      400,
      -32000,
    ],
  ] as const)(
    'rejects %s with SDK errors',
    async (_name, body, headers, status, code) => {
      const response = await http('/mcp', 'POST', body, {
        ...baselineHeaders,
        ...headers,
      });
      expect(response.status).toBe(status);
      expect(message(response.text).error.code).toBe(code);
    },
  );

  it.each([
    ['invalid tool arguments', STATUS_TOOL, { unexpected: true }],
    ['unknown tool', 'system.not_registered', {}],
  ])('rejects %s through the SDK', async (_name, name, args) => {
    const response = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(response.status).toBe(200);
    if (name === STATUS_TOOL)
      expect(message(response.text).result.isError).toBe(true);
    else expect(message(response.text).error.code).toBe(-32602);
  });

  it('bounds request bodies before parsing', async () => {
    const response = await http(
      '/mcp',
      'POST',
      'x'.repeat(64 * 1024 + 1),
      baselineHeaders,
    );
    expect(response.status).toBe(413);
  });

  it('works with a new server instance after shutdown', async () => {
    const previous = await startService(
      readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
    );
    const port = previous.address.port;
    try {
      const opening = await fetch(`${previous.url}/mcp`, {
        method: 'POST',
        headers: baselineHeaders,
        body: JSON.stringify(initialize),
      });
      expect(opening.status).toBe(200);
      expect(message(await opening.text()).result.protocolVersion).toBe(
        MCP_PROTOCOL_BASELINE,
      );
    } finally {
      await previous.close();
    }
    const replacement = await startService(
      readConfig({ MCP_PORT: String(port), NODE_ENV: 'test' }),
    );
    try {
      const response = await fetch(`${replacement.url}/mcp`, {
        method: 'POST',
        headers: baselineHeaders,
        body: JSON.stringify(list),
      });
      expect(response.status).toBe(200);
      expect(message(await response.text()).result.tools[0].name).toBe(
        STATUS_TOOL,
      );
    } finally {
      await replacement.close();
    }
  });
});

describe('transport security', () => {
  it('actually binds the listener to IPv4 loopback', () => {
    expect(service.address.address).toBe('127.0.0.1');
  });
  it.each(['http://localhost:6274', 'http://127.0.0.1:6274'])(
    'accepts the allowed local Origin %s',
    async (origin) => {
      const response = await post(list, { Origin: origin });
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    },
  );
  it.each([
    'https://evil.example',
    'http://localhost:9999',
    'https://localhost:6274',
    'null',
    'not-an-origin',
  ])('rejects disallowed Origin %s', async (origin) => {
    const response = await post(list, { Origin: origin });
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('permits non-browser clients with no Origin', async () => {
    const response = await post(list);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it.each(['localhost:12345', '127.0.0.1:12345', '[::1]:12345'])(
    'accepts allowed Host hostname %s',
    async (host) => {
      expect((await post(list, { Host: host })).status).toBe(200);
    },
  );
  it.each(['evil.example', 'localhost.evil.example', 'evil.example:3001'])(
    'rejects invalid Host %s',
    async (host) => {
      expect((await post(list, { Host: host })).status).toBe(403);
    },
  );
  it('does not trust forwarded host headers', async () => {
    expect(
      (
        await post(list, {
          Host: 'evil.example',
          'X-Forwarded-Host': 'localhost',
        })
      ).status,
    ).toBe(403);
  });
  it('handles browser preflight only after the guards', async () => {
    const allowed = await http('/mcp', 'OPTIONS', undefined, {
      Origin: 'http://localhost:6274',
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:6274',
    );
    expect(
      (
        await http('/mcp', 'OPTIONS', undefined, {
          Origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
  });
});

describe('AgentCore managed ingress mode', () => {
  it('permits machine-to-machine MCP requests and rejects browser Origin traffic', async () => {
    const configured = readConfig({
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'production',
    });
    const agentCoreService = await startService({
      ...configured,
      bindHost: '127.0.0.1',
      port: 0,
    });

    const requestAgentCore = (
      origin?: string,
    ): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          new URL('/mcp', agentCoreService.url),
          {
            method: 'POST',
            headers: {
              ...baselineHeaders,
              ...(origin ? { Origin: origin } : {}),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(list));
      });

    try {
      const machine = await requestAgentCore();
      expect(machine.status).toBe(200);
      expect(message(machine.text).result.tools[0].name).toBe(STATUS_TOOL);

      const browser = await requestAgentCore('https://example.com');
      expect(browser.status).toBe(403);
      expect(JSON.parse(browser.text)).toEqual({
        error: 'Browser origin not allowed',
      });
    } finally {
      await agentCoreService.close();
    }
  });
});

describe('operational endpoints', () => {
  it('returns deterministic health without any backing services', async () => {
    const response = await http('/health');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ status: 'ok' });
  });
  it('returns only public version metadata', async () => {
    const response = await http('/version');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      service: SERVICE,
      version: VERSION,
      mcpProtocolBaseline: MCP_PROTOCOL_BASELINE,
      environment: 'test',
    });
  });
  it.each(['/health', '/version'])(
    'protects %s with the same guards and restricts methods',
    async (path) => {
      expect(
        (await http(path, 'GET', undefined, { Host: 'evil.example' })).status,
      ).toBe(403);
      expect(
        (await http(path, 'GET', undefined, { Origin: 'https://evil.example' }))
          .status,
      ).toBe(403);
      expect((await http(path, 'POST')).status).toBe(405);
    },
  );
  it('does not expose legacy SSE or unrelated routes', async () => {
    expect((await http('/sse')).status).toBe(404);
    expect((await http('/messages')).status).toBe(404);
  });
});
