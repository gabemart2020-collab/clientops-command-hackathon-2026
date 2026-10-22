/**
 * SQL trigger definition guaranteeing DB-level immutability for audit records.
 *
 * Implements the verified requirement that audit records are strictly append-only.
 * Any attempt to perform UPDATE or DELETE on audit_events raises an exception at
 * the PostgreSQL database engine level.
 */
export const AUDIT_IMMUTABILITY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION prevent_audit_events_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only. UPDATE and DELETE operations are strictly prohibited on table audit_events.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events;
CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_modification();
`.trim();

export class AuditImmutabilityViolationError extends Error {
  constructor(public readonly operation: 'UPDATE' | 'DELETE') {
    super(
      `Security violation: Attempted '${operation}' operation on append-only audit trail. Audit events can only be inserted, never modified or deleted.`,
    );
    this.name = 'AuditImmutabilityViolationError';
  }
}

/**
 * Asserts that an audit store operation is strictly append-only ('INSERT').
 * Throws AuditImmutabilityViolationError if an UPDATE or DELETE is attempted.
 */
export function assertAppendOnlyOperation(
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
): void {
  if (operation === 'UPDATE' || operation === 'DELETE') {
    throw new AuditImmutabilityViolationError(operation);
  }
}
