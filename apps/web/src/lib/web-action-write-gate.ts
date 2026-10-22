/**
 * Explicit server-side authorization gate for governed web action writes.
 * Demo/read-only is the default. Neither client input nor model output may
 * enable proposal registration, approval decisions, or task execution.
 */
export function areWebActionWritesEnabled(): boolean {
  return process.env.CLIENTOPS_WEB_ACTION_WRITES_ENABLED === 'true';
}
