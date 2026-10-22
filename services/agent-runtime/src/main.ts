import {
  AgentCoreMcpAdapter,
  Phase521UnboundAgentCoreInvoker,
} from './agentcore-mcp.js';
import { loadAgentRuntimeServiceConfig } from './config.js';
import {
  createAgentRuntimeHandler,
  createDefaultAgentFactory,
} from './handler.js';
import { closeHttpServer, createAgentRuntimeHttpServer } from './server.js';

const config = loadAgentRuntimeServiceConfig();
const adapter = new AgentCoreMcpAdapter(
  config,
  new Phase521UnboundAgentCoreInvoker(),
);

const handler = createAgentRuntimeHandler(config, {
  loadTools: () => adapter.createModelTools(),
  createAgent: createDefaultAgentFactory(config),
});

const server = createAgentRuntimeHttpServer(config, handler);

server.listen(config.port, config.host, () => {
  console.log('ClientOps Agent Runtime listener ready.', {
    host: config.host,
    port: config.port,
    phase: '5.2.1',
    awsDataPlaneBinding: 'pending-phase-5.2.3',
    proposerBinding: 'pending-phase-5.2.2',
  });
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log('ClientOps Agent Runtime shutting down.', { signal });
  try {
    await closeHttpServer(server);
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
