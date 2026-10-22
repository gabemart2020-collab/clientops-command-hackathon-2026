-- Phase 5.1 non-destructive staging seed for remote MCP certification.
-- Synthetic data only. No TRUNCATE, DELETE, DROP, or reset behavior.
-- Intended for a fresh isolated ClientOps staging database after migrations.
-- Re-running is idempotent because every insert uses ON CONFLICT DO NOTHING.

INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
('10000000-0000-4000-8000-000000000001', 'ClientOps Command Demo Org', 'clientops-demo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
('20000000-0000-4000-8000-000000000002', 'BetaCorp Systems', 'betacorp-systems', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, organization_id, email, name, role, created_at, updated_at) VALUES
('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'alice.walker@clientops-demo.internal', 'Alice Walker', 'operator', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
('10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'bob.vance@clientops-demo.internal', 'Bob Vance', 'lead', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
('20000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000002', 'carol.danvers@betacorp.internal', 'Carol Danvers', 'operator', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO clients (id, organization_id, name, slug, industry, tier, created_at, updated_at) VALUES
('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Acme Labs', 'acme-labs', 'Enterprise Biotechnology', 'enterprise', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
('c0000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000002', 'Acme Labs', 'acme-labs-betacorp', 'Manufacturing', 'standard', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO projects (id, organization_id, client_id, name, status, lead_user_id, target_completion_at, created_at, updated_at) VALUES
('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Cloud Analytics Migration', 'active', '10000000-0000-4000-8000-000000000011', '2026-11-15T18:00:00Z', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z'),
('a0000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000021', 'BetaCorp Pilot Integration', 'active', '20000000-0000-4000-8000-000000000021', '2026-12-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO milestones (id, organization_id, project_id, title, status, due_at, completed_at, created_at, updated_at) VALUES
('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Architecture Sign-off', 'completed', '2026-09-30T17:00:00Z', '2026-09-29T16:30:00Z', '2026-09-05T00:00:00Z', '2026-09-29T16:30:00Z'),
('b0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Production Data Migration', 'open', '2026-10-13T09:00:00Z', NULL, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z'),
('b0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Cutover & Final Acceptance', 'open', '2026-10-31T17:00:00Z', NULL, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO tasks (id, organization_id, project_id, milestone_id, title, status, assignee_user_id, due_at, completed_at, created_at, updated_at) VALUES
('d0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Configure IAM sync policies', 'completed', '10000000-0000-4000-8000-000000000011', '2026-10-12T17:00:00Z', '2026-10-12T16:00:00Z', '2026-10-01T00:00:00Z', '2026-10-12T16:00:00Z'),
('d0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Validate staging ETL pipeline', 'completed', '10000000-0000-4000-8000-000000000012', '2026-10-11T18:00:00Z', '2026-10-11T17:45:00Z', '2026-10-01T00:00:00Z', '2026-10-11T17:45:00Z'),
('d0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Deploy telemetry forwarder', 'completed', '10000000-0000-4000-8000-000000000011', '2026-10-10T17:00:00Z', '2026-10-10T14:15:00Z', '2026-10-01T00:00:00Z', '2026-10-10T14:15:00Z'),
('d0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'Execute final schema delta validation', 'in_progress', '10000000-0000-4000-8000-000000000011', '2026-10-17T17:00:00Z', NULL, '2026-10-10T00:00:00Z', '2026-10-14T09:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO meetings (id, organization_id, client_id, project_id, title, scheduled_at, status, summary, created_at, updated_at) VALUES
('e0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Executive Review', '2026-10-16T14:00:00Z', 'scheduled', 'Quarterly executive review covering migration status and cutover readiness.', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
('e0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Bi-weekly Working Session', '2026-10-08T15:00:00Z', 'completed', 'Reviewed migration architecture and agreed on cutover schedule.', '2026-09-25T00:00:00Z', '2026-10-08T16:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO communications (id, organization_id, client_id, channel, subject, summary, occurred_at, requires_response, resolved_at, created_at, updated_at) VALUES
('f0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'email', 'Discrepancy in Q3 Analytics Export', 'Client team noticed export figures for Q3 do not reconcile with source warehouse.', '2026-10-14T11:00:00Z', true, NULL, '2026-10-14T11:00:00Z', '2026-10-14T11:00:00Z'),
('f0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'email', 'Migration cutover checklist review', 'Sent updated cutover checklist to client technical director.', '2026-10-12T10:00:00Z', false, NULL, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z'),
('f0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'note', 'Weekly Sync Notes', 'Recap of working session sent to executive stakeholders.', '2026-10-09T15:00:00Z', false, NULL, '2026-10-09T15:00:00Z', '2026-10-09T15:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO commitments (id, organization_id, client_id, project_id, description, owner_user_id, due_at, status, fulfilled_at, originating_evidence_type, originating_evidence_id, created_at, updated_at) VALUES
('c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Deliver revised schema documentation', '10000000-0000-4000-8000-000000000011', '2026-10-10T17:00:00Z', 'fulfilled', '2026-10-10T15:00:00Z', 'meeting', 'e0000000-0000-4000-8000-000000000002', '2026-10-08T16:00:00Z', '2026-10-10T15:00:00Z'),
('c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Provide updated cutover rollback runbook', '10000000-0000-4000-8000-000000000012', '2026-10-18T17:00:00Z', 'open', NULL, 'meeting', 'e0000000-0000-4000-8000-000000000002', '2026-10-08T16:00:00Z', '2026-10-08T16:00:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO decisions (id, organization_id, client_id, project_id, title, rationale, decided_at, decided_by_user_id, created_at, updated_at) VALUES
('de000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Dual-Write Buffer Window', 'Agreed to maintain a 48-hour dual-write buffer following the cutover.', '2026-10-09T16:00:00Z', '10000000-0000-4000-8000-000000000011', '2026-10-09T16:00:00Z', '2026-10-09T16:00:00Z')
ON CONFLICT DO NOTHING;
