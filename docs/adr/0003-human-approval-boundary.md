# 0003: Human approval boundary

Status: Accepted architectural decision for this project.
Date: 2026-09-26.
Authority: user project brief and Phase 0 design; not an independently verified Amazon rule.

## Context

An LLM is an untrusted proposer and cannot be the authority that permits its own mutations.

## Decision

Human approval resolution belongs to a separate authenticated application boundary and is never exposed as an MCP tool. WRITE execution requires deterministic server-side verification of a durable human decision bound to exact action context. EXTERNAL and DESTRUCTIVE actions are outside v1.

## Consequences

Future implementations must enforce identity, tenant, argument binding, expiry, stale-state rejection and atomic replay prevention. Model text and tool annotations confer no authority. Phase 0 records the rule but implements no workflow.

## Alternatives considered

An approve tool available to the agent or approval inferred from generated prose would allow self-authorization.

Changes to this decision require a superseding ADR and explicit user agreement before implementation.
