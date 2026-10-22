import type { ActorRole, TrustedActorContext } from '@clientops/contracts';
import type { TenantContext } from '@clientops/domain';

/**
 * Standard fixture actor UUID for local demonstration and development.
 */
export const LOCAL_DEMO_OPERATOR_ACTOR_ID =
  '10000000-0000-4000-8000-000000000011';

export class SecurityBoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityBoundaryViolationError';
  }
}

/**
 * Creates a server-side TrustedActorContext for local development and demonstration.
 *
 * STRICT SECURITY INVARIANT:
 * This adapter is prohibited in production. Outside development/testing environments,
 * it fails closed and throws an exception.
 */
export function createLocalDemoActorContext(
  tenantContext: TenantContext,
  options?: {
    actorId?: string;
    role?: ActorRole;
  },
): TrustedActorContext {
  const env = process.env.NODE_ENV;
  const isDevOrTest = env === 'development' || env === 'test';
  const optInEnabled = process.env.CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR === 'true';

  // Permitted in test runner by default, or in development when explicitly opted in via CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true
  const isPermitted = isDevOrTest && (env === 'test' || optInEnabled);

  if (!isPermitted) {
    throw new SecurityBoundaryViolationError(
      `Security boundary violation: LocalDemoActorAdapter is prohibited in environment '${env ?? 'undefined'}'. It is permitted ONLY when NODE_ENV is 'development' or 'test' and CLIENTOPS_ENABLE_LOCAL_DEMO_ACTOR=true. Staging, preview, undefined, and production environments fail closed. A production authenticated actor context is required.`,
    );
  }

  return {
    organizationId: tenantContext.organizationId,
    actorId: options?.actorId ?? LOCAL_DEMO_OPERATOR_ACTOR_ID,
    role: options?.role ?? 'operator',
    source: 'local_demo_adapter',
    isProductionActor: false,
  };
}

/**
 * Server-owned actor resolution boundary.
 * Resolves TrustedActorContext strictly on the server; untrusted clients/browsers
 * can NEVER supply identity fields.
 */
export function resolveTrustedActor(
  tenantContext: TenantContext,
  options?: {
    actorId?: string;
    role?: ActorRole;
  },
): TrustedActorContext {
  return createLocalDemoActorContext(tenantContext, options);
}

export interface TrustedActorProvider {
  resolveActor(
    tenantContext: TenantContext,
    options?: {
      actorId?: string;
      role?: ActorRole;
    },
  ): Promise<TrustedActorContext>;
}

export class DefaultTrustedActorProvider implements TrustedActorProvider {
  async resolveActor(
    tenantContext: TenantContext,
    options?: {
      actorId?: string;
      role?: ActorRole;
    },
  ): Promise<TrustedActorContext> {
    return resolveTrustedActor(tenantContext, options);
  }
}

/**
 * Asserts that an actor holds an authorized role to approve actions.
 * Only 'admin' and 'operator' roles are permitted; 'viewer' is denied.
 */
export function assertAuthorizedApproverRole(actor: TrustedActorContext): void {
  if (actor.role !== 'admin' && actor.role !== 'operator') {
    throw new Error(
      `Actor '${actor.actorId}' with role '${actor.role}' is not authorized to approve actions. Required role: 'admin' or 'operator'.`,
    );
  }
}
