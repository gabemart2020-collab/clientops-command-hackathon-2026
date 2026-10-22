'use client';

import { useState } from 'react';
import type { OrchestrationResult } from '@/lib/orchestrator';
import type { AgentRunResult } from '@clientops/agent';

const DEMO_CLIENTS = [
  'Acme Labs',
  'Northstar Health',
  'Meridian Retail',
  'Atlas Studio',
];

export default function DemoPage() {
  const [mode, setMode] = useState<'agentic' | 'deterministic'>('agentic');
  const [selectedClient, setSelectedClient] = useState('Acme Labs');
  const [agentPrompt, setAgentPrompt] = useState(
    "Prepare me for tomorrow's Acme review.",
  );

  const [loading, setLoading] = useState(false);
  const [detData, setDetData] = useState<OrchestrationResult | null>(null);
  const [agentData, setAgentData] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<{
    message: string;
    isMcpUnavailable: boolean;
    isAuthError?: boolean;
  } | null>(null);

  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});

  const toggleEvidence = (findingId: string) => {
    setOpenEvidence((prev) => ({
      ...prev,
      [findingId]: !prev[findingId],
    }));
  };

  const runDeterministicWorkflow = async (clientName: string) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRef: clientName }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        const isMcp =
          response.status === 503 ||
          json.code === 'MCP_UNAVAILABLE' ||
          (json.error && json.error.includes('MCP_UNAVAILABLE'));
        setError({
          message:
            json.error || 'Failed to execute review preparation workflow.',
          isMcpUnavailable: Boolean(isMcp),
        });
        setDetData(null);
      } else {
        setDetData(json.data);
      }
    } catch (err) {
      setError({
        message:
          (err as Error).message ||
          'Network error communicating with demo server.',
        isMcpUnavailable: true,
      });
      setDetData(null);
    } finally {
      setLoading(false);
    }
  };

  const runAgenticWorkflow = async (prompt: string, clientHint: string) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: prompt,
          accountHint: clientHint,
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        const isMcp =
          response.status === 503 ||
          json.code === 'MCP_UNAVAILABLE' ||
          (json.error && json.error.includes('MCP_UNAVAILABLE'));
        const isAuth =
          json.code === 'AWS_BEDROCK_AUTH_ERROR' ||
          (json.error && json.error.includes('AWS_BEDROCK_AUTH_ERROR'));

        setError({
          message: json.error || 'Failed to execute agentic briefing workflow.',
          isMcpUnavailable: Boolean(isMcp),
          isAuthError: Boolean(isAuth),
        });
        if (json.data) {
          setAgentData(json.data);
        } else {
          setAgentData(null);
        }
      } else {
        setAgentData(json.data);
      }
    } catch (err) {
      setError({
        message:
          (err as Error).message ||
          'Network error communicating with agent API route.',
        isMcpUnavailable: false,
      });
      setAgentData(null);
    } finally {
      setLoading(false);
    }
  };

  const handleRun = () => {
    if (mode === 'agentic') {
      runAgenticWorkflow(agentPrompt, selectedClient);
    } else {
      runDeterministicWorkflow(selectedClient);
    }
  };

  // Mode and account selection only update UI state. Network work is explicit.
  const clearResults = () => {
    setDetData(null);
    setAgentData(null);
    setError(null);
    setOpenEvidence({});
  };

  const selectClient = (clientName: string) => {
    setSelectedClient(clientName);
    setAgentPrompt(
      clientName === 'Acme Labs'
        ? "Prepare me for tomorrow's Acme review."
        : `Prepare me for the ${clientName} review.`,
    );
    clearResults();
  };

  const changeMode = (nextMode: 'agentic' | 'deterministic') => {
    if (nextMode !== mode) {
      setMode(nextMode);
      clearResults();
    }
  };

  // Deterministic brief data
  const detBrief = detData?.brief;
  const detClientContext = detData?.clientContext;
  const detHealthStatus = detBrief?.projectStatus?.health ?? 'on_track';

  // Agentic brief data
  const agentBrief = agentData?.brief;
  const agentHealthStatus = agentBrief?.health ?? 'on_track';

  return (
    <div className="container">
      <header className="header">
        <div className="header-title">
          <h1>ClientOps Command</h1>
          <p>
            {mode === 'agentic'
              ? 'Phase 3: Agentic Orchestration with Amazon Bedrock + Strands'
              : 'Phase 2: Deterministic Business Slice via Streamable HTTP MCP'}
          </p>
        </div>
        <div>
          <span className="scenario-badge">
            Scenario Now: 2026-10-15T09:00:00Z
          </span>
        </div>
      </header>

      {/* Mode Switcher */}
      <div className="mode-toggle-bar">
        <button
          className={`mode-btn ${mode === 'agentic' ? 'active' : ''}`}
          onClick={() => changeMode('agentic')}
          disabled={loading}
        >
          Agentic Mode (Phase 3: Bedrock + Strands)
        </button>
        <button
          className={`mode-btn ${mode === 'deterministic' ? 'active' : ''}`}
          onClick={() => changeMode('deterministic')}
          disabled={loading}
        >
          Deterministic Mode (Phase 2: Reference)
        </button>
      </div>

      {/* Control Bar: Account Selector */}
      <div className="control-bar">
        <div className="client-select-group">
          <label htmlFor="client-select">Select Demo Account:</label>
          <select
            id="client-select"
            className="client-select"
            value={selectedClient}
            onChange={(e) => selectClient(e.target.value)}
            disabled={loading}
          >
            {DEMO_CLIENTS.map((client) => (
              <option key={client} value={client}>
                {client} {client === 'Acme Labs' ? '(Hero Scenario)' : ''}
              </option>
            ))}
          </select>
        </div>
        {mode === 'deterministic' && (
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={loading}
          >
            {loading ? 'Executing MCP Tools...' : 'Prepare Executive Review'}
          </button>
        )}
      </div>

      {/* Agentic Prompt Input (Visible in Agentic Mode) */}
      {mode === 'agentic' && (
        <div className="agent-prompt-bar">
          <label
            htmlFor="agent-prompt"
            style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            ClientOps Agent Prompt:
          </label>
          <textarea
            id="agent-prompt"
            className="agent-prompt-input"
            rows={2}
            value={agentPrompt}
            onChange={(e) => setAgentPrompt(e.target.value)}
            placeholder="Ask the ClientOps agent about account status, risks, commitments..."
            disabled={loading}
          />
          <div className="agent-actions">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Model chooses tools dynamically across authorized MCP endpoints.
            </div>
            <button
              className="btn-primary"
              onClick={handleRun}
              disabled={loading}
            >
              {loading ? 'Agent Orchestrating...' : 'Ask ClientOps Agent'}
            </button>
          </div>
        </div>
      )}

      {/* Error / MCP Down / Auth Error Banner */}
      {error && (
        <div className="error-banner">
          <h3>
            {error.isMcpUnavailable
              ? 'ClientOps MCP Server Unavailable'
              : error.isAuthError
                ? 'Amazon Bedrock Authentication Required'
                : 'Workflow Execution Failed'}
          </h3>
          <p>{error.message}</p>
          {error.isMcpUnavailable && (
            <div>
              <p style={{ marginTop: '0.5rem', color: '#94a3b8' }}>
                Start the local MCP Streamable HTTP service in a terminal:
              </p>
              <code>pnpm dev:mcp</code>
            </div>
          )}
          {error.isAuthError && (
            <p style={{ marginTop: '0.5rem', color: '#94a3b8' }}>
              Ensure standard AWS credentials (`AWS_REGION`, Bedrock model
              access) are configured in the environment.
            </p>
          )}
        </div>
      )}

      {/* MODE 1: AGENTIC RESULTS */}
      {mode === 'agentic' && agentData && (
        <div>
          {/* Runtime & Model Metadata Panel */}
          <div className="meta-stats-panel">
            <div className="meta-stat-item">
              <span className="meta-stat-label">Model Provider</span>
              <span className="meta-stat-value">Amazon Bedrock</span>
            </div>
            <div className="meta-stat-item">
              <span className="meta-stat-label">Model ID</span>
              <span className="meta-stat-value">{agentData.modelId}</span>
            </div>
            <div className="meta-stat-item">
              <span className="meta-stat-label">Stop Reason</span>
              <span className="meta-stat-value">{agentData.stopReason}</span>
            </div>
            <div className="meta-stat-item">
              <span className="meta-stat-label">Latency</span>
              <span className="meta-stat-value">{agentData.latencyMs}ms</span>
            </div>
            {agentData.tokenUsage && (
              <div className="meta-stat-item">
                <span className="meta-stat-label">Tokens (In / Out / Tot)</span>
                <span className="meta-stat-value">
                  {agentData.tokenUsage.inputTokens ?? 0} /{' '}
                  {agentData.tokenUsage.outputTokens ?? 0} /{' '}
                  {agentData.tokenUsage.totalTokens ?? 0}
                </span>
              </div>
            )}
          </div>

          {/* Grounding Status Banner */}
          <div
            className={`grounding-banner ${
              agentData.grounding.valid
                ? 'grounding-valid'
                : 'grounding-invalid'
            }`}
          >
            <div>
              <strong>
                {agentData.grounding.valid
                  ? '✓ Grounding Verified:'
                  : '⚠ Grounding Issue:'}
              </strong>{' '}
              {agentData.grounding.groundedEvidenceCount} evidence reference(s)
              matched against {agentData.grounding.authoritativeEvidenceCount}{' '}
              authoritative records.
            </div>
            <div>
              <strong>
                Unsupported Evidence:{' '}
                {agentData.grounding.unsupportedEvidenceCount}
              </strong>
            </div>
          </div>

          {/* Account Overview & Delivery Health Badge */}
          {agentBrief && (
            <div className="account-overview-card">
              <div className="account-meta">
                <h2>{agentBrief.account?.name ?? selectedClient}</h2>
                {agentBrief.meeting && (
                  <div className="meeting-info">
                    <strong>Upcoming Meeting:</strong>{' '}
                    {agentBrief.meeting.title} &bull;{' '}
                    <span>
                      {new Date(agentBrief.meeting.scheduledAt).toUTCString()} (
                      {agentBrief.meeting.scheduledAt.includes('2026-10-16')
                        ? 'Tomorrow'
                        : 'Upcoming'}
                      )
                    </span>
                  </div>
                )}
                <div
                  style={{
                    fontSize: '0.95rem',
                    color: '#e2e8f0',
                    marginTop: '0.75rem',
                    lineHeight: 1.6,
                  }}
                >
                  {agentBrief.answer}
                </div>
              </div>

              <div>
                {agentHealthStatus === 'at_risk' && (
                  <div className="health-badge-large health-at-risk">
                    AT RISK
                  </div>
                )}
                {agentHealthStatus === 'watch' && (
                  <div className="health-badge-large health-watch">WATCH</div>
                )}
                {agentHealthStatus === 'on_track' && (
                  <div className="health-badge-large health-on-track">
                    ON TRACK
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Fallback to raw text if no structured brief */}
          {!agentBrief && agentData.rawText && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <div className="card-title">Agent Response</div>
              <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {agentData.rawText}
              </p>
            </div>
          )}

          {/* Grid: Grounded Findings & Suggested Next Steps */}
          {agentBrief && (
            <div className="grid-2">
              {/* Grounded Findings */}
              <div className="card">
                <div className="card-title">
                  <span>Grounded Findings</span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {agentBrief.findings.length} findings
                  </span>
                </div>

                {agentBrief.findings.length === 0 ? (
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.9rem',
                    }}
                  >
                    No material risk findings identified.
                  </p>
                ) : (
                  agentBrief.findings.map((finding, idx) => {
                    const findingKey = `finding-${idx}`;
                    const isExpanded = openEvidence[findingKey] || false;

                    return (
                      <div key={findingKey} className="risk-item">
                        <div className="risk-item-header">
                          <span className="risk-item-title">
                            {finding.statement}
                          </span>
                        </div>

                        {finding.evidence.length > 0 && (
                          <button
                            className="evidence-trigger-btn"
                            onClick={() => toggleEvidence(findingKey)}
                          >
                            {isExpanded
                              ? `Hide Evidence (${finding.evidence.length}) ▴`
                              : `View Authoritative Evidence (${finding.evidence.length}) ▾`}
                          </button>
                        )}

                        {isExpanded && (
                          <div className="evidence-drawer">
                            {finding.evidence.map((ref, rIdx) => (
                              <div
                                key={rIdx}
                                style={{
                                  marginBottom:
                                    rIdx < finding.evidence.length - 1
                                      ? '0.75rem'
                                      : 0,
                                }}
                              >
                                <h4>
                                  <span>Source Entity:</span>
                                  <span className="evidence-code">
                                    {ref.entityType}
                                  </span>
                                </h4>
                                <div className="evidence-prop">
                                  <strong>Entity ID:</strong>{' '}
                                  <span className="evidence-code">
                                    {ref.entityId}
                                  </span>
                                </div>
                                {ref.field && (
                                  <div className="evidence-prop">
                                    <strong>Evaluated Field:</strong>{' '}
                                    {ref.field}
                                  </div>
                                )}
                                {ref.excerpt && (
                                  <div className="evidence-prop">
                                    <strong>Record Excerpt:</strong> &ldquo;
                                    {ref.excerpt}&rdquo;
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Suggested Next Steps */}
              <div className="card">
                <div className="card-title">
                  <span>Suggested Next Steps</span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {agentBrief.suggestedNextSteps.length} recommendations
                  </span>
                </div>
                {agentBrief.suggestedNextSteps.length === 0 ? (
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.9rem',
                    }}
                  >
                    No immediate follow-up required.
                  </p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {agentBrief.suggestedNextSteps.map((step, index) => (
                      <li key={index} className="next-step-item">
                        <span className="next-step-bullet">&bull;</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* MCP Tool Execution Trace */}
          <div className="trace-panel">
            <div className="trace-header">
              <span>
                Agentic MCP Tool Execution Trace (Strands McpClient over
                Streamable HTTP)
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                Dynamically Discovered &bull; Bounded Loop
              </span>
            </div>
            {agentData.toolTrace.length === 0 ? (
              <p
                style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}
              >
                No tools called.
              </p>
            ) : (
              agentData.toolTrace.map((step, idx) => (
                <div key={idx} className="trace-step">
                  <div>
                    <span className="trace-tool-name">{step.toolName}</span>
                    <span style={{ color: '#64748b', marginLeft: '0.75rem' }}>
                      {JSON.stringify(step.arguments)}
                    </span>
                  </div>
                  <div>
                    <span className="trace-timing">{step.durationMs}ms</span>
                    <span
                      style={{ marginLeft: '1rem' }}
                      className={
                        step.status === 'ok'
                          ? 'trace-status-ok'
                          : 'trace-status-error'
                      }
                    >
                      [{step.status.toUpperCase()}]
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* MODE 2: DETERMINISTIC RESULTS (PHASE 2 REFERENCE) */}
      {mode === 'deterministic' && detData && detBrief && detClientContext && (
        <div>
          {/* Account Overview & Delivery Health Badge */}
          <div className="account-overview-card">
            <div className="account-meta">
              <h2>{detClientContext.client.name}</h2>
              <div className="meeting-info">
                <strong>Upcoming Meeting:</strong> {detBrief.meeting.title}{' '}
                &bull;{' '}
                <span>
                  {new Date(detBrief.meeting.scheduledAt).toUTCString()} (
                  {detBrief.meeting.scheduledAt.includes('2026-10-16')
                    ? 'Tomorrow'
                    : 'Upcoming'}
                  )
                </span>
              </div>
              <div
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-muted)',
                  marginTop: '0.25rem',
                }}
              >
                Tier:{' '}
                <strong style={{ color: '#cbd5e1' }}>
                  {detClientContext.client.tier}
                </strong>{' '}
                &bull; Industry:{' '}
                <strong style={{ color: '#cbd5e1' }}>
                  {detClientContext.client.industry}
                </strong>
              </div>
            </div>

            <div>
              {detHealthStatus === 'at_risk' && (
                <div className="health-badge-large health-at-risk">AT RISK</div>
              )}
              {detHealthStatus === 'watch' && (
                <div className="health-badge-large health-watch">WATCH</div>
              )}
              {detHealthStatus === 'on_track' && (
                <div className="health-badge-large health-on-track">
                  ON TRACK
                </div>
              )}
            </div>
          </div>

          {/* Grid: Risk Findings & Talking Points */}
          <div className="grid-2">
            {/* Risk Findings with Evidence */}
            <div className="card">
              <div className="card-title">
                <span>Deterministic Risk Findings</span>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {detBrief.riskFindings.length} identified
                </span>
              </div>

              {detBrief.riskFindings.length === 0 ? (
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.9rem',
                  }}
                >
                  No active risk factors found. Milestones and commitments are
                  on track.
                </p>
              ) : (
                detBrief.riskFindings.map((finding) => {
                  const findingKey = `${finding.category}-${finding.evidence.entityId}`;
                  const isExpanded = openEvidence[findingKey] || false;

                  return (
                    <div
                      key={findingKey}
                      className={
                        finding.severity === 'high'
                          ? 'risk-item'
                          : 'risk-item-watch'
                      }
                    >
                      <div className="risk-item-header">
                        <span className="risk-item-title">
                          {finding.description}
                        </span>
                        <span
                          className={`risk-severity-badge ${
                            finding.severity === 'high'
                              ? 'severity-high'
                              : 'severity-medium'
                          }`}
                        >
                          {finding.severity}
                        </span>
                      </div>
                      <div className="risk-item-description">
                        Category:{' '}
                        <strong style={{ color: '#cbd5e1' }}>
                          {finding.category}
                        </strong>
                      </div>

                      <button
                        className="evidence-trigger-btn"
                        onClick={() => toggleEvidence(findingKey)}
                      >
                        {isExpanded
                          ? 'Hide Evidence ▴'
                          : 'View Authoritative Evidence ▾'}
                      </button>

                      {isExpanded && (
                        <div className="evidence-drawer">
                          <h4>
                            <span>Source Record:</span>
                            <span className="evidence-code">
                              {finding.evidence.entityType}
                            </span>
                          </h4>
                          <div className="evidence-prop">
                            <strong>Entity ID:</strong>{' '}
                            <span className="evidence-code">
                              {finding.evidence.entityId}
                            </span>
                          </div>
                          {finding.evidence.field && (
                            <div className="evidence-prop">
                              <strong>Evaluated Field:</strong>{' '}
                              {finding.evidence.field}
                            </div>
                          )}
                          {finding.evidence.excerpt && (
                            <div className="evidence-prop">
                              <strong>Record Excerpt:</strong> &ldquo;
                              {finding.evidence.excerpt}&rdquo;
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Factual Meeting Talking Points */}
            <div className="card">
              <div className="card-title">
                <span>Deterministic Briefing Points</span>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {detBrief.talkingPoints.length} points
                </span>
              </div>
              <ul className="talking-points-list">
                {detBrief.talkingPoints.map((point, index) => (
                  <li key={index} className="talking-point-item">
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Grid: Open Commitments & Recent Activity */}
          <div className="grid-2">
            {/* Open Commitments */}
            <div className="card">
              <div className="card-title">
                <span>Open Commitments</span>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {detBrief.openCommitments.length} open
                </span>
              </div>
              {detBrief.openCommitments.length === 0 ? (
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.9rem',
                  }}
                >
                  No open commitments pending.
                </p>
              ) : (
                detBrief.openCommitments.map((commitment) => (
                  <div key={commitment.id} className="list-item">
                    <div>
                      <div className="list-item-title">
                        {commitment.description}
                      </div>
                      <div className="list-item-sub">
                        Due: {new Date(commitment.dueAt).toLocaleDateString()}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        color: '#60a5fa',
                        background: '#1e3a5f',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                      }}
                    >
                      OPEN
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Recent Activity */}
            <div className="card">
              <div className="card-title">
                <span>Recent Activity</span>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {detBrief.recentActivity.length} items
                </span>
              </div>
              {detBrief.recentActivity.length === 0 ? (
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.9rem',
                  }}
                >
                  No recent activity recorded.
                </p>
              ) : (
                detBrief.recentActivity.slice(0, 5).map((activity) => (
                  <div key={activity.id} className="list-item">
                    <div>
                      <div className="list-item-title">{activity.summary}</div>
                      <div className="list-item-sub">
                        Type: {activity.type} &bull;{' '}
                        {new Date(activity.occurredAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* MCP Protocol Execution Trace */}
          <div className="trace-panel">
            <div className="trace-header">
              <span>
                MCP Protocol Execution Trace (Official MCP Client over
                Streamable HTTP)
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                Baseline 2025-11-25 &bull; Deterministic Reference Mode
              </span>
            </div>
            {detData.trace.map((step, idx) => (
              <div key={idx} className="trace-step">
                <div>
                  <span className="trace-tool-name">{step.tool}</span>
                  <span style={{ color: '#64748b', marginLeft: '0.75rem' }}>
                    {JSON.stringify(step.arguments)}
                  </span>
                </div>
                <div>
                  <span className="trace-timing">{step.durationMs}ms</span>
                  <span
                    style={{ marginLeft: '1rem' }}
                    className={
                      step.status === 'ok'
                        ? 'trace-status-ok'
                        : 'trace-status-error'
                    }
                  >
                    [{step.status.toUpperCase()}]
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
