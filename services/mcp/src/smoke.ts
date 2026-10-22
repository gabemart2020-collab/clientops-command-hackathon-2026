import assert from 'node:assert/strict';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { readConfig, MCP_PROTOCOL_BASELINE } from './config.js';
import { startService } from './index.js';
import { SERVICE, VERSION, STATUS_TOOL, statusSchema } from './protocol.js';

// An isolated loopback listener; ignores ambient configuration and needs no secrets.
const service = await startService(
  readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
);
const client = new Client(
  { name: 'clientops-smoke', version: VERSION },
  {
    supportedProtocolVersions: [MCP_PROTOCOL_BASELINE],
    versionNegotiation: { mode: 'legacy' },
  },
);
const transport = new StreamableHTTPClientTransport(
  new URL(`${service.url}/mcp`),
);
try {
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'legacy');
  assert.equal(transport.protocolVersion, MCP_PROTOCOL_BASELINE);
  assert.equal(client.getServerVersion()?.name, SERVICE);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [STATUS_TOOL],
  );
  const result = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  assert.notEqual(result.isError, true);
  statusSchema.parse(result.structuredContent);
  console.log(
    `PASS MCP ${transport.protocolVersion}: initialize -> tools/list -> ${STATUS_TOOL}`,
  );
  console.log(JSON.stringify(result.structuredContent));
} finally {
  await client.close();
  await service.close();
}
