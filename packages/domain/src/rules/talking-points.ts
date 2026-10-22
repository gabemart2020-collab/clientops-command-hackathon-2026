import type {
  CommitmentEntity,
  MeetingEntity,
  ProjectEntity,
} from '../entities.js';
import type { DeliveryHealthEvaluationResult } from './delivery-health.js';

export interface DeriveTalkingPointsParams {
  meeting: MeetingEntity;
  project?: ProjectEntity | undefined;
  healthResult?: DeliveryHealthEvaluationResult | undefined;
  openCommitments: CommitmentEntity[];
  completedTasksCount: number;
  evaluationTime: Date;
}

export function deriveTalkingPoints(
  params: DeriveTalkingPointsParams,
): string[] {
  const {
    meeting,
    project,
    healthResult,
    openCommitments,
    completedTasksCount,
    evaluationTime,
  } = params;

  const points: string[] = [];

  // 1. Meeting schedule relative fact
  const meetingEpoch = new Date(meeting.scheduledAt).getTime();
  const diffHours =
    (meetingEpoch - evaluationTime.getTime()) / (1000 * 60 * 60);
  if (diffHours > 0 && diffHours <= 36) {
    points.push(
      `Executive review meeting scheduled for tomorrow (${meeting.scheduledAt}).`,
    );
  } else {
    points.push(
      `Meeting "${meeting.title}" scheduled for ${meeting.scheduledAt}.`,
    );
  }

  // 2. Project delivery health fact
  if (project && healthResult) {
    const healthLabel = healthResult.health.toUpperCase().replace('_', ' ');
    points.push(
      `Project "${project.name}" delivery health status evaluated as ${healthLabel}.`,
    );

    // 3. Highlight material risks
    for (const finding of healthResult.findings) {
      if (finding.severity === 'high' || finding.severity === 'critical') {
        points.push(`Risk item: ${finding.title} — ${finding.description}`);
      }
    }
  }

  // 4. Open commitments fact
  if (openCommitments.length > 0) {
    points.push(
      `Account has ${openCommitments.length} open commitment(s) requiring operational follow-up.`,
    );
  } else {
    points.push('All client commitments currently fulfilled or on schedule.');
  }

  // 5. Recent task velocity fact
  if (completedTasksCount > 0) {
    points.push(
      `${completedTasksCount} task(s) recently completed in the active project scope.`,
    );
  }

  return points;
}
