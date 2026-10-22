/**
 * Shared server-side tenant boundary.
 *
 * All business repository operations require a verified TenantContext.
 * The organizationId MUST NEVER be accepted as an untrusted tool argument
 * from the browser or model; it is bound strictly by server configuration
 * or authenticated request context.
 */

export interface TenantContext {
  readonly organizationId: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTenantContext(organizationId: string): TenantContext {
  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new Error(
      `Invalid tenant context: organizationId must be a valid UUID. Received: ${organizationId}`,
    );
  }
  return { organizationId };
}

/**
 * Canonical fixture IDs for fictional local demonstration.
 * These are configuration aids, never privileged credentials.
 */
export const DEMO_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
export const SECOND_TEST_ORGANIZATION_ID =
  '20000000-0000-4000-8000-000000000002';
