import {
  ClientOpsAgent,
  resolveAwsCredentials,
  isToolAuthorized,
} from '../packages/agent/src/index.js';
import { AgentBriefSchema } from '../packages/contracts/src/index.js';
import {
  startClientOpsService,
  readConfig,
} from '../services/mcp/src/index.js';
import { closeDatabasePool } from '../packages/data/src/index.js';

async function isMcpServerReachable(url: string): Promise<boolean> {
  try {
    const healthUrl = url.replace(/\/mcp\/?$/, '/health');
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error(
      '\n[WATCHDOG TIMEOUT] Smoke test exceeded maximum wall-clock timeout (120s). Force exiting.',
    );
    process.exit(1);
  }, 120_000);
  watchdog.unref();

  console.log(
    '================================================================================',
  );
  console.log('ClientOps Command — Phase 3 Live Bedrock Smoke Test');
  console.log(
    '================================================================================',
  );

  let localService: { close(): Promise<void>; url: string } | undefined;
  let agent: ClientOpsAgent | undefined;

  try {
    const modelId = process.env.BEDROCK_MODEL_ID;
    if (!modelId || !modelId.trim()) {
      console.error('');
      console.error(
        'CONFIG ERROR: BEDROCK_MODEL_ID environment variable is required.',
      );
      console.error(
        'Do not rely on silent default model fallbacks for live Bedrock certification.',
      );
      console.error(
        'Recommended: BEDROCK_MODEL_ID=us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      );
      console.error(
        '================================================================================',
      );
      process.exitCode = 1;
      return;
    }

    const region = process.env.AWS_REGION ?? 'us-east-1';
    console.log(
      `[CONFIG] Deliberate Bedrock Model: ${modelId} | Region: ${region}`,
    );
    console.log(
      '[ENV CHECK] Resolving AWS SDK Node.js credential provider chain...',
    );

    const credCheck = await resolveAwsCredentials(modelId, region);

    if (!credCheck.available) {
      console.error('');
      console.error(
        'STATUS: BLOCKED — LIVE BEDROCK CERTIFICATION PENDING (AWS credentials could not be resolved from environment, profile, SSO, or instance metadata)',
      );
      console.error(`Detail: ${credCheck.error}`);
      console.error('');
      console.error('To certify against live Amazon Bedrock:');
      console.error(
        '  1. Configure AWS credentials (e.g. AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, or AWS_PROFILE).',
      );
      console.error(
        '  2. Set BEDROCK_MODEL_ID=us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      );
      console.error('  3. Re-run: pnpm smoke:agent:live');
      console.error(
        '================================================================================',
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      '[ENV CHECK] AWS credentials detected. Preparing live agent run...',
    );
    const mcpUrl = process.env.CLIENTOPS_MCP_URL ?? 'http://127.0.0.1:3001/mcp';

    let activeMcpUrl = mcpUrl;

    const reachable = await isMcpServerReachable(mcpUrl);
    if (reachable) {
      console.log(
        `[MCP CONNECT] Connected to existing MCP server at ${mcpUrl}`,
      );
    } else {
      console.log(
        `[MCP CONNECT] Local MCP server at ${mcpUrl} not reachable; spinning up in-process service...`,
      );
      localService = await startClientOpsService(
        readConfig({ MCP_PORT: '0', NODE_ENV: 'test' }),
      );
      activeMcpUrl = `${localService.url}/mcp`;
      console.log(
        `[MCP CONNECT] In-process MCP server listening at ${activeMcpUrl}`,
      );
    }

    agent = new ClientOpsAgent({
      config: {
        mcpUrl: activeMcpUrl,
        bedrockModelId: modelId,
        awsRegion: region,
      },
    });

    console.log(
      `[AGENT RUN] Model: ${agent.getConfig().bedrockModelId} in ${agent.getConfig().awsRegion}`,
    );
    console.log(
      '[AGENT RUN] Prompt: "Prepare me for tomorrow\'s Acme review." (Target: Acme Labs)',
    );

    const startTime = Date.now();
    const result = await agent.prepareClientBrief({
      userMessage: "Prepare me for tomorrow's Acme review.",
      accountHint: 'Acme Labs',
    });

    const elapsed = Date.now() - startTime;
    console.log(
      `[AGENT RUN] Completed in ${elapsed}ms | Status: ${result.success ? 'SUCCESS' : 'FAILED'}`,
    );

    if (!result.success) {
      console.error(`[AGENT ERROR] ${result.error ?? 'Unknown error'}`);
      process.exitCode = 1;
      return;
    }

    // Verify assertions
    if (!result.brief) {
      console.error('[ASSERTION FAILED] Agent returned no structured brief.');
      process.exitCode = 1;
      return;
    }

    const parsedBrief = AgentBriefSchema.safeParse(result.brief);
    if (!parsedBrief.success) {
      console.error(
        '[ASSERTION FAILED] Brief does not conform to AgentBriefSchema:',
        parsedBrief.error,
      );
      process.exitCode = 1;
      return;
    }

    const brief = result.brief;

    // 1. Account name === "Acme Labs"
    if (brief.account?.name?.trim().toLowerCase() !== 'acme labs') {
      console.error(
        `[ASSERTION FAILED] Expected account.name to be "Acme Labs", got "${brief.account?.name}".`,
      );
      process.exitCode = 1;
      return;
    }

    // 2. Meeting title contains "Executive Review"
    if (!brief.meeting?.title?.toLowerCase().includes('executive review')) {
      console.error(
        `[ASSERTION FAILED] Expected meeting.title to contain "Executive Review", got "${brief.meeting?.title}".`,
      );
      process.exitCode = 1;
      return;
    }

    // 3. Health === "at_risk"
    if (brief.health !== 'at_risk') {
      console.error(
        `[ASSERTION FAILED] Expected health to be "at_risk", got "${brief.health}".`,
      );
      process.exitCode = 1;
      return;
    }

    // 4. At least one migration-related finding exists
    const hasMigrationFinding = brief.findings.some((f) => {
      const statementMatch = f.statement.toLowerCase().includes('migration');
      const evidenceMatch = f.evidence.some((e) =>
        e.excerpt?.toLowerCase().includes('migration'),
      );
      return statementMatch || evidenceMatch;
    });
    if (!hasMigrationFinding) {
      console.error(
        '[ASSERTION FAILED] Expected at least one migration-related finding in brief.',
      );
      process.exitCode = 1;
      return;
    }

    // 4b. Verify migration finding, evidence, or answer reflects 2 full days overdue
    const reflectsTwoDaysOverdue =
      brief.findings.some(
        (f) =>
          (f.statement.toLowerCase().includes('migration') &&
            (f.statement.toLowerCase().includes('2 day') ||
              f.statement.toLowerCase().includes('two day'))) ||
          f.evidence.some(
            (e) =>
              e.excerpt?.toLowerCase().includes('migration') &&
              e.excerpt?.toLowerCase().includes('2 day'),
          ),
      ) ||
      (brief.answer.toLowerCase().includes('migration') &&
        (brief.answer.toLowerCase().includes('2 day') ||
          brief.answer.toLowerCase().includes('two day')));

    if (!reflectsTwoDaysOverdue) {
      console.error(
        '[ASSERTION FAILED] Expected migration finding, evidence, or answer to reflect 2 full days overdue.',
      );
      process.exitCode = 1;
      return;
    }

    // 5. All findings have valid authoritative evidence and unsupportedEvidenceCount === 0
    if (
      !result.grounding.valid ||
      result.grounding.unsupportedEvidenceCount > 0
    ) {
      console.error(
        `[ASSERTION FAILED] Grounding check failed with ${result.grounding.unsupportedEvidenceCount} unsupported references.`,
      );
      process.exitCode = 1;
      return;
    }
    const allFindingsHaveEvidence =
      brief.findings.length > 0 &&
      brief.findings.every((f) => f.evidence && f.evidence.length > 0);
    if (!allFindingsHaveEvidence) {
      console.error(
        '[ASSERTION FAILED] Every finding must include at least one valid evidence reference.',
      );
      process.exitCode = 1;
      return;
    }

    // 6. At least one authorized MCP tool was selected by the model
    if (result.toolTrace.length === 0) {
      console.error(
        '[ASSERTION FAILED] Agent called 0 tools during execution.',
      );
      process.exitCode = 1;
      return;
    }
    const authorizedToolCalled = result.toolTrace.some((t) =>
      isToolAuthorized(t.toolName),
    );
    if (!authorizedToolCalled) {
      console.error(
        '[ASSERTION FAILED] No authorized ClientOps MCP tool was called by the agent.',
      );
      process.exitCode = 1;
      return;
    }

    console.log('\n--- LIVE BEDROCK CERTIFICATION RESULT ---');
    console.log(`Model ID:           ${result.modelId}`);
    console.log(
      `Tools Invoked:      ${result.toolTrace.map((t) => t.toolName).join(', ')}`,
    );
    console.log(`Total Latency:      ${result.latencyMs}ms`);
    if (result.tokenUsage) {
      console.log(
        `Token Usage:        ${result.tokenUsage.totalTokens} (in: ${result.tokenUsage.inputTokens}, out: ${result.tokenUsage.outputTokens})`,
      );
    }
    console.log(
      `Grounding Status:   VALID (${result.grounding.groundedEvidenceCount} evidence refs grounded, 0 unsupported)`,
    );
    console.log(`Account:            ${result.brief.account?.name ?? 'N/A'}`);
    console.log(`Health Status:      ${result.brief.health ?? 'N/A'}`);
    console.log(`Findings Count:     ${result.brief.findings.length}`);
    console.log(
      `Suggested Next Steps: ${result.brief.suggestedNextSteps.length}`,
    );
    console.log('\nBrief Executive Summary:');
    console.log(result.brief.answer);
    console.log(
      '================================================================================',
    );
    console.log('STATUS: CERTIFIED — LIVE BEDROCK SMOKE PASSED');
    console.log(
      '================================================================================',
    );
  } finally {
    clearTimeout(watchdog);
    if (agent) {
      await agent.close();
    }
    if (localService) {
      await localService.close();
    }
    await closeDatabasePool();
  }
}

main().catch(async (err) => {
  console.error('[FATAL ERROR]', err);
  await closeDatabasePool().catch(() => {});
  process.exit(1);
});
