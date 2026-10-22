'use client';

import { use, useEffect, useState } from 'react';

interface ProposalDetail {
  id: string;
  actionType: string;
  actionClass: string;
  status: string;
  client: {
    id: string;
    name: string;
    tier: string;
  };
  project: {
    id: string;
    name: string;
    status: string;
  };
  task: {
    title: string;
    description?: string;
    priority: string;
    dueAt?: string;
    assigneeUserId?: string;
    assigneeDisplayName?: string;
    milestoneId?: string;
    milestoneTitle?: string;
  };
  justification: string;
  evidence: Array<{
    entityType: string;
    entityId: string;
    field?: string;
    excerpt?: string;
  }>;
  createdAt: string;
  expiresAt: string;
}

export default function ActionProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const { proposalId } = use(params);
  const [proposal, setProposal] = useState<ProposalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [decisionResult, setDecisionResult] = useState<{
    status: string;
    decision: string;
    decidedAt: string;
    execution?: {
      status: 'COMPLETED' | 'FAILED' | 'UNCONFIRMED' | 'BLOCKED' | 'EXPIRED';
      code?: string;
      reason?: string;
      executionId?: string;
      completedAt?: string;
      task?: {
        id: string;
        title: string;
        status: string;
        projectId: string;
        priority: string;
      };
      errorCode?: string;
      failureSummary?: string;
      message?: string;
    };
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    async function fetchProposal() {
      try {
        const res = await fetch(`/api/actions/${proposalId}`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          if (mounted)
            setError(json.message || 'Failed to load proposal details.');
        } else if (mounted) {
          setProposal(json.data);
          if (
            json.data.status === 'APPROVED' ||
            json.data.status === 'DENIED' ||
            json.data.status === 'COMPLETED' ||
            json.data.status === 'FAILED' ||
            json.data.status === 'EXPIRED'
          ) {
            setDecisionResult({
              status: json.data.status,
              decision: json.data.status === 'DENIED' ? 'DENY' : 'APPROVE',
              decidedAt: json.data.createdAt,
            });
          }
        }
      } catch {
        if (mounted) setError('Network error fetching proposal details.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    fetchProposal();
    return () => {
      mounted = false;
    };
  }, [proposalId]);

  const handleDecision = async (decision: 'APPROVE' | 'DENY') => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/actions/${proposalId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || 'Failed to submit decision.');
      } else {
        setDecisionResult(json.data);
      }
    } catch {
      setError('Network error submitting decision.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main
        style={{ padding: '3rem 1.5rem', maxWidth: '800px', margin: '0 auto' }}
      >
        <p style={{ color: 'var(--text-secondary)' }}>Loading proposal...</p>
      </main>
    );
  }

  if (error && !proposal) {
    return (
      <main
        style={{ padding: '3rem 1.5rem', maxWidth: '800px', margin: '0 auto' }}
      >
        <div
          style={{
            padding: '1.5rem',
            background: '#3b1c1c',
            border: '1px solid #7f1d1d',
            borderRadius: '8px',
          }}
        >
          <h2 style={{ color: '#fca5a5', marginBottom: '0.5rem' }}>
            Proposal Not Available
          </h2>
          <p style={{ color: '#fecaca' }}>{error}</p>
        </div>
      </main>
    );
  }

  if (!proposal) return null;

  const currentStatus = decisionResult?.status ?? proposal.status;

  return (
    <main
      style={{ padding: '3rem 1.5rem', maxWidth: '800px', margin: '0 auto' }}
    >
      <header style={{ marginBottom: '2rem' }}>
        <span
          style={{
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '0.25rem 0.5rem',
            borderRadius: '4px',
            background: 'var(--bg-surface)',
            color: 'var(--accent-blue)',
            fontWeight: 600,
          }}
        >
          Controlled Action Approval
        </span>
        <h1
          style={{ fontSize: '1.75rem', marginTop: '0.5rem', fontWeight: 700 }}
        >
          PROPOSED ACTION: Create recovery task
        </h1>
      </header>

      <section
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            rowGap: '0.75rem',
            fontSize: '0.95rem',
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>Client:</span>
          <strong>{proposal.client.name}</strong>

          <span style={{ color: 'var(--text-secondary)' }}>Project:</span>
          <strong>{proposal.project.name}</strong>

          <span style={{ color: 'var(--text-secondary)' }}>Title:</span>
          <span>{proposal.task.title}</span>

          {proposal.task.description && (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>
                Description:
              </span>
              <span>{proposal.task.description}</span>
            </>
          )}

          <span style={{ color: 'var(--text-secondary)' }}>Priority:</span>
          <span style={{ textTransform: 'capitalize' }}>
            {proposal.task.priority}
          </span>

          {proposal.task.dueAt && (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>Due:</span>
              <span>{new Date(proposal.task.dueAt).toLocaleString()}</span>
            </>
          )}

          {proposal.task.assigneeDisplayName && (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>Assignee:</span>
              <span>
                {proposal.task.assigneeDisplayName}
                {proposal.task.assigneeUserId && (
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                      marginLeft: '0.5rem',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    ({proposal.task.assigneeUserId})
                  </span>
                )}
              </span>
            </>
          )}

          {proposal.task.milestoneId && (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>Milestone:</span>
              <span>
                {proposal.task.milestoneTitle ?? proposal.task.milestoneId}
                {proposal.task.milestoneTitle && (
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                      marginLeft: '0.5rem',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    ({proposal.task.milestoneId})
                  </span>
                )}
              </span>
            </>
          )}

          <span style={{ color: 'var(--text-secondary)' }}>Why:</span>
          <span>{proposal.justification}</span>

          <span style={{ color: 'var(--text-secondary)' }}>Evidence:</span>
          <div>
            {proposal.evidence.map((ev, idx) => (
              <div
                key={idx}
                style={{
                  marginBottom: '0.25rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.85rem',
                }}
              >
                • {ev.entityType}:{ev.entityId}
                {ev.field ? `.${ev.field}` : ''}
                {ev.excerpt ? ` — "${ev.excerpt}"` : ''}
              </div>
            ))}
          </div>

          <span style={{ color: 'var(--text-secondary)' }}>Expires:</span>
          <span>{new Date(proposal.expiresAt).toLocaleString()}</span>
        </div>
      </section>

      {error && (
        <div
          style={{
            padding: '1rem',
            background: '#3b1c1c',
            border: '1px solid #7f1d1d',
            borderRadius: '6px',
            marginBottom: '1.5rem',
            color: '#fecaca',
            fontSize: '0.9rem',
          }}
        >
          {error}
        </div>
      )}

      {currentStatus === 'PENDING_APPROVAL' ? (
        <section
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '1.5rem',
          }}
        >
          <p
            style={{
              fontWeight: 600,
              color: 'var(--text-primary)',
              marginBottom: '1rem',
            }}
          >
            Approval authorizes creation of exactly this task.
          </p>

          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="comment"
              style={{
                display: 'block',
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.5rem',
              }}
            >
              Approval / Denial comment (optional, max 500 characters):
            </label>
            <textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              placeholder="e.g. Approved per incident sync"
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                minHeight: '80px',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={() => handleDecision('APPROVE')}
              disabled={submitting}
              style={{
                background: '#10b981',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '0.75rem 1.5rem',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? 'Submitting...' : 'Approve'}
            </button>
            <button
              onClick={() => handleDecision('DENY')}
              disabled={submitting}
              style={{
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '0.75rem 1.5rem',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? 'Submitting...' : 'Deny'}
            </button>
          </div>
        </section>
      ) : currentStatus === 'COMPLETED' ||
        decisionResult?.execution?.status === 'COMPLETED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid #10b981',
            borderRadius: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#10b981',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            APPROVED
          </span>
          <h3
            style={{
              color: '#10b981',
              fontSize: '1.25rem',
              marginTop: '0.25rem',
              marginBottom: '0.75rem',
            }}
          >
            TASK CREATED
          </h3>
          <div
            style={{
              fontSize: '0.9rem',
              color: 'var(--text-primary)',
              display: 'grid',
              rowGap: '0.5rem',
            }}
          >
            <div>
              <strong>Title: </strong>
              <span>
                {decisionResult?.execution?.task?.title ?? proposal.task.title}
              </span>
            </div>
            <div>
              <strong>Project: </strong>
              <span>{proposal.project.name}</span>
            </div>
            <div>
              <strong>Status: </strong>
              <span>{decisionResult?.execution?.task?.status ?? 'open'}</span>
            </div>
            {decisionResult?.execution?.task?.id && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Task ID: {decisionResult.execution.task.id}
              </div>
            )}
          </div>
        </div>
      ) : currentStatus === 'FAILED' ||
        decisionResult?.execution?.status === 'FAILED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#ef4444',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            APPROVED
          </span>
          <h3
            style={{
              color: '#ef4444',
              fontSize: '1.25rem',
              marginTop: '0.25rem',
              marginBottom: '0.75rem',
            }}
          >
            EXECUTION FAILED
          </h3>
          <p style={{ color: '#fca5a5', fontSize: '0.9rem' }}>
            {decisionResult?.execution?.failureSummary ??
              'Task creation failed during execution.'}
          </p>
        </div>
      ) : decisionResult?.execution?.status === 'UNCONFIRMED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid #f59e0b',
            borderRadius: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#f59e0b',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            APPROVED
          </span>
          <h3
            style={{
              color: '#f59e0b',
              fontSize: '1.25rem',
              marginTop: '0.25rem',
              marginBottom: '0.75rem',
            }}
          >
            EXECUTION NOT CONFIRMED
          </h3>
          <p
            style={{
              color: '#fcd34d',
              fontSize: '0.9rem',
              marginBottom: '1rem',
            }}
          >
            {decisionResult.execution.message ??
              'Execution outcome could not be confirmed. Safe to retry.'}
          </p>
          <button
            onClick={() => handleDecision('APPROVE')}
            disabled={submitting}
            style={{
              background: '#f59e0b',
              color: '#000000',
              border: 'none',
              borderRadius: '6px',
              padding: '0.6rem 1.2rem',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'Retrying...' : 'Retry Execution'}
          </button>
        </div>
      ) : decisionResult?.execution?.status === 'BLOCKED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#ef4444',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            APPROVED — EXECUTION BLOCKED
          </span>
          <h3
            style={{
              color: '#ef4444',
              fontSize: '1.25rem',
              marginTop: '0.25rem',
              marginBottom: '0.75rem',
            }}
          >
            {decisionResult.execution.code ?? 'EXECUTION_BLOCKED'}
          </h3>
          <p style={{ color: '#fca5a5', fontSize: '0.9rem' }}>
            {decisionResult.execution.message}
          </p>
        </div>
      ) : currentStatus === 'EXPIRED' ||
        decisionResult?.execution?.status === 'EXPIRED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(107, 114, 128, 0.1)',
            border: '1px solid #6b7280',
            borderRadius: '8px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#9ca3af',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            EXPIRED
          </span>
          <h3
            style={{
              color: '#9ca3af',
              fontSize: '1.25rem',
              marginTop: '0.25rem',
              marginBottom: '0.75rem',
            }}
          >
            {decisionResult?.execution?.reason === 'APPROVAL_EXPIRED'
              ? 'APPROVAL VALIDITY EXPIRED'
              : 'PROPOSAL EXPIRED'}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {decisionResult?.execution?.message ??
              'Action proposal authorization has expired. Execution is prohibited.'}
          </p>
        </div>
      ) : currentStatus === 'APPROVED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid #10b981',
            borderRadius: '8px',
          }}
        >
          <h3
            style={{
              color: '#10b981',
              fontSize: '1.2rem',
              marginBottom: '0.5rem',
            }}
          >
            APPROVED
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Human approval was recorded. Awaiting execution confirmation.
          </p>
        </div>
      ) : currentStatus === 'DENIED' ? (
        <div
          style={{
            padding: '1.5rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
          }}
        >
          <h3
            style={{
              color: '#ef4444',
              fontSize: '1.2rem',
              marginBottom: '0.5rem',
            }}
          >
            DENIED — no action will be executed
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            This action proposal was explicitly denied by an authorized
            approver.
          </p>
        </div>
      ) : (
        <div
          style={{
            padding: '1.5rem',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
          }}
        >
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            Status: {currentStatus}
          </h3>
        </div>
      )}
    </main>
  );
}
