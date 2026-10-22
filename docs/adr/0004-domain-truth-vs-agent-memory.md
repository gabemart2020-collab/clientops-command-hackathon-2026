# 0004: Domain truth versus agent memory

Status: Accepted architectural decision for this project.
Date: 2026-09-26.
Authority: user project brief and Phase 0 design; not an independently verified Amazon rule.

## Context

Generated explanations and remembered conversation can be stale, incomplete or incorrect. Operational decisions need traceable evidence.

## Decision

Business records in backing stores are source truth. Model output and agent memory are derived and non-authoritative. Preserve evidence references and append-only audit records separately from mutable domain state.

## Consequences

Later reads must recheck authorization and freshness. Authorized deterministic commands alone may mutate business records. Audit corrections append new events. Memory design and retention remain deferred.

## Alternatives considered

Treating a transcript or generated summary as business state would break provenance and reliable concurrency.

Changes to this decision require a superseding ADR and explicit user agreement before implementation.
