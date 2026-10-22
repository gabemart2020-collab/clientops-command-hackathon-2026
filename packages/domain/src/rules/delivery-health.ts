import type {
  DeliveryHealthStatus,
  EvidenceRef,
  RiskFinding,
} from '@clientops/contracts';
import type {
  CommitmentEntity,
  CommunicationEntity,
  MilestoneEntity,
  TaskEntity,
} from '../entities.js';

export interface AssessDeliveryHealthParams {
  projectId: string;
  clientId: string;
  milestones: MilestoneEntity[];
  tasks: TaskEntity[];
  communications: CommunicationEntity[];
  commitments: CommitmentEntity[];
  evaluationTime: Date;
}

export interface DeliveryHealthEvaluationResult {
  projectId: string;
  clientId: string;
  health: DeliveryHealthStatus;
  findings: RiskFinding[];
  evidence: EvidenceRef[];
  evaluatedAt: string;
}

export function evaluateDeliveryHealth(
  params: AssessDeliveryHealthParams,
): DeliveryHealthEvaluationResult {
  const {
    projectId,
    clientId,
    milestones,
    tasks,
    communications,
    commitments,
    evaluationTime,
  } = params;

  const findings: RiskFinding[] = [];
  const evidenceList: EvidenceRef[] = [];

  const evalIso = evaluationTime.toISOString();
  const evalEpoch = evaluationTime.getTime();

  // 1. Overdue Milestones:
  // A milestone is overdue when due_at < evaluation_time AND status is not completed/cancelled
  for (const milestone of milestones) {
    if (milestone.status !== 'completed' && milestone.status !== 'cancelled') {
      const dueEpoch = new Date(milestone.dueAt).getTime();
      if (dueEpoch < evalEpoch) {
        const daysOverdue = Math.max(
          1,
          Math.floor((evalEpoch - dueEpoch) / (1000 * 60 * 60 * 24)),
        );
        const evidence: EvidenceRef = {
          entityType: 'milestone',
          entityId: milestone.id,
          field: 'due_at',
          excerpt: `Milestone "${milestone.title}" due ${milestone.dueAt} is ${daysOverdue} day(s) overdue (status: ${milestone.status})`,
        };
        evidenceList.push(evidence);
        evidenceList.push({
          entityType: 'milestone',
          entityId: milestone.id,
          field: 'status',
          excerpt: milestone.status,
        });
        findings.push({
          id: `finding-milestone-overdue-${milestone.id}`,
          category: 'milestone_overdue',
          severity: 'high',
          title: `Milestone Overdue: ${milestone.title}`,
          description: `Milestone was due on ${milestone.dueAt} and remains in "${milestone.status}" status (${daysOverdue} days past target).`,
          evidence,
        });
      }
    }
  }

  // 2. Unresolved Client Questions:
  // Modelled explicitly via requiresResponse === true AND resolvedAt is null/undefined
  for (const comm of communications) {
    if (comm.requiresResponse && !comm.resolvedAt) {
      const evidence: EvidenceRef = {
        entityType: 'communication',
        entityId: comm.id,
        field: 'requires_response',
        excerpt: `Communication "${comm.subject}" on ${comm.occurredAt} requires response and is unresolved`,
      };
      evidenceList.push(evidence);
      evidenceList.push({
        entityType: 'communication',
        entityId: comm.id,
        field: 'resolved_at',
        excerpt: comm.resolvedAt ?? 'unresolved',
      });
      findings.push({
        id: `finding-unresolved-question-${comm.id}`,
        category: 'unresolved_question',
        severity: 'high',
        title: `Unresolved Client Inquiry: ${comm.subject}`,
        description: `Client inquiry received via ${comm.channel} on ${comm.occurredAt} has requires_response=true and has not been resolved.`,
        evidence,
      });
    }
  }

  // 3. Overdue Commitments:
  // A commitment is overdue when due_at < evaluation_time AND status is open
  for (const commitment of commitments) {
    if (commitment.status === 'open') {
      const dueEpoch = new Date(commitment.dueAt).getTime();
      if (dueEpoch < evalEpoch) {
        const daysOverdue = Math.max(
          1,
          Math.floor((evalEpoch - dueEpoch) / (1000 * 60 * 60 * 24)),
        );
        const evidence: EvidenceRef = {
          entityType: 'commitment',
          entityId: commitment.id,
          field: 'due_at',
          excerpt: `Commitment "${commitment.description}" was due ${commitment.dueAt}`,
        };
        evidenceList.push(evidence);
        evidenceList.push({
          entityType: 'commitment',
          entityId: commitment.id,
          field: 'status',
          excerpt: commitment.status,
        });
        findings.push({
          id: `finding-commitment-overdue-${commitment.id}`,
          category: 'commitment_overdue',
          severity: 'high',
          title: `Overdue Commitment: ${commitment.description}`,
          description: `Commitment was due on ${commitment.dueAt} and remains open (${daysOverdue} days overdue).`,
          evidence,
        });
      }
    }
  }

  // 4. Overdue Tasks:
  // A task is overdue when due_at < evaluation_time AND status is not completed/cancelled
  for (const task of tasks) {
    if (
      task.dueAt &&
      task.status !== 'completed' &&
      task.status !== 'cancelled'
    ) {
      const dueEpoch = new Date(task.dueAt).getTime();
      if (dueEpoch < evalEpoch) {
        const evidence: EvidenceRef = {
          entityType: 'task',
          entityId: task.id,
          field: 'due_at',
          excerpt: `Task "${task.title}" was due ${task.dueAt}`,
        };
        evidenceList.push(evidence);
        evidenceList.push({
          entityType: 'task',
          entityId: task.id,
          field: 'status',
          excerpt: task.status,
        });
        findings.push({
          id: `finding-task-overdue-${task.id}`,
          category: 'task_overdue',
          severity: 'medium',
          title: `Overdue Task: ${task.title}`,
          description: `Task in project was due on ${task.dueAt} and is currently in "${task.status}" status.`,
          evidence,
        });
      }
    }
  }

  // Deterministic aggregate health rule:
  // Any critical/high finding -> at_risk
  // Any medium finding -> watch
  // None -> on_track
  let health: DeliveryHealthStatus = 'on_track';
  if (
    findings.some((f) => f.severity === 'critical' || f.severity === 'high')
  ) {
    health = 'at_risk';
  } else if (findings.some((f) => f.severity === 'medium')) {
    health = 'watch';
  }

  return {
    projectId,
    clientId,
    health,
    findings,
    evidence: evidenceList,
    evaluatedAt: evalIso,
  };
}
