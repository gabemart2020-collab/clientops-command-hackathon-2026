/**
 * Clock abstraction for deterministic time handling across ClientOps Command.
 *
 * Three distinct clock operational modes:
 * 1. System Clock: Default machine time (new Date()), used for production/live runtime.
 * 2. Test Clock: Injected arbitrary fixed or stepped timestamp, used for unit and edge-case testing.
 * 3. Demo Scenario Clock: Fixed canonical timestamp (2026-10-15T09:00:00.000Z), used to keep
 *    the fictional demonstration scenario (Acme Labs executive review tomorrow, migration milestone
 *    2 days overdue) deterministic and resilient to the real passage of time.
 */

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  private readonly fixedTime: Date;

  constructor(time: string | number | Date) {
    this.fixedTime = new Date(time);
    if (isNaN(this.fixedTime.getTime())) {
      throw new Error(
        `Invalid date string or timestamp passed to FixedClock: ${time}`,
      );
    }
  }

  now(): Date {
    return new Date(this.fixedTime.getTime());
  }
}

/**
 * The canonical demo scenario timestamp:
 * 2026-10-15T09:00:00.000Z
 *
 * Relative scenario facts:
 * - Executive Review: 2026-10-16T14:00:00.000Z (tomorrow)
 * - Migration Milestone: 2026-10-13T09:00:00.000Z (2 days overdue)
 * - Analytics Question: 2026-10-14T11:00:00.000Z (unresolved client inquiry)
 */
export const DEMO_SCENARIO_TIMESTAMP = '2026-10-15T09:00:00.000Z';

export class DemoScenarioClock extends FixedClock {
  constructor() {
    super(DEMO_SCENARIO_TIMESTAMP);
  }
}
