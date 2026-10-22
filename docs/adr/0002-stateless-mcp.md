# 0002: Process-stateless MCP

Status: Accepted architectural decision for this project.
Date: 2026-09-26.
Authority: user project brief and Phase 0 design; not an independently verified Amazon rule.

## Context

The service must remain correct across restarts and multiple runtime instances. Protocol sessions are not a durable business store.

## Decision

Use MCP baseline 2025-11-25 over Streamable HTTP. Keep process-local state transient; store business, approval, idempotency and audit records in durable backing stores. Do not depend on in-memory sessions for correctness.

## Consequences

Later work must verify SDK compatibility, authentication and crash/concurrency behavior. Durable transaction boundaries require explicit design. No MCP implementation exists in Phase 0.

## Alternatives considered

Process-local maps or sticky-session correctness would violate the durability requirement.

Changes to this decision require a superseding ADR and explicit user agreement before implementation.
