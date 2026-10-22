import {
  GetAccountContextInputSchema,
  GetAccountContextOutputSchema,
} from './account.js';
import {
  RecentActivityInputSchema,
  RecentActivityOutputSchema,
} from './activity.js';
import {
  ListOpenCommitmentsInputSchema,
  ListOpenCommitmentsOutputSchema,
} from './commitment.js';
import {
  AssessDeliveryHealthInputSchema,
  AssessDeliveryHealthOutputSchema,
} from './health.js';
import {
  PrepareBriefInputSchema,
  PrepareBriefOutputSchema,
} from './meeting.js';

export const TOOL_NAMES = {
  ACCOUNT_GET_CONTEXT: 'account.get_context',
  ACTIVITY_GET_RECENT: 'activity.get_recent',
  COMMITMENT_LIST_OPEN: 'commitment.list_open',
  PROJECT_ASSESS_DELIVERY_HEALTH: 'project.assess_delivery_health',
  MEETING_PREPARE_BRIEF: 'meeting.prepare_brief',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

import type { ActionClass } from './action.js';

export interface ToolContractMeta {
  readonly name: ToolName;
  readonly classification: ActionClass;
  readonly description: string;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
}

export const CLIENTOPS_TOOL_DEFINITIONS = {
  [TOOL_NAMES.ACCOUNT_GET_CONTEXT]: {
    name: TOOL_NAMES.ACCOUNT_GET_CONTEXT,
    classification: 'READ',
    description:
      'Retrieve structured client operations context, active projects, upcoming meetings, and open commitment count for a client reference.',
    readOnly: true,
    idempotent: true,
    inputSchema: GetAccountContextInputSchema,
    outputSchema: GetAccountContextOutputSchema,
  },
  [TOOL_NAMES.ACTIVITY_GET_RECENT]: {
    name: TOOL_NAMES.ACTIVITY_GET_RECENT,
    classification: 'READ',
    description:
      'Retrieve normalized recent activity (communications, completed tasks, meetings, decisions) within a bounded lookback window.',
    readOnly: true,
    idempotent: true,
    inputSchema: RecentActivityInputSchema,
    outputSchema: RecentActivityOutputSchema,
  },
  [TOOL_NAMES.COMMITMENT_LIST_OPEN]: {
    name: TOOL_NAMES.COMMITMENT_LIST_OPEN,
    classification: 'READ',
    description:
      'List all unresolved/open commitments for a given client, including owners, due dates, and originating evidence.',
    readOnly: true,
    idempotent: true,
    inputSchema: ListOpenCommitmentsInputSchema,
    outputSchema: ListOpenCommitmentsOutputSchema,
  },
  [TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH]: {
    name: TOOL_NAMES.PROJECT_ASSESS_DELIVERY_HEALTH,
    classification: 'ANALYZE',
    description:
      'Perform deterministic delivery-health assessment for a project, detecting overdue milestones, overdue tasks, and unresolved client questions with authoritative evidence.',
    readOnly: true,
    idempotent: true,
    inputSchema: AssessDeliveryHealthInputSchema,
    outputSchema: AssessDeliveryHealthOutputSchema,
  },
  [TOOL_NAMES.MEETING_PREPARE_BRIEF]: {
    name: TOOL_NAMES.MEETING_PREPARE_BRIEF,
    classification: 'ANALYZE',
    description:
      'Compose a deterministic structured meeting brief combining client context, project health, recent activity, open commitments, risk findings, and evidence-backed facts.',
    readOnly: true,
    idempotent: true,
    inputSchema: PrepareBriefInputSchema,
    outputSchema: PrepareBriefOutputSchema,
  },
} as const;
