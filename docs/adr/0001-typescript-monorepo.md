# 0001: TypeScript monorepo

Status: Accepted architectural decision for this project.
Date: 2026-09-26.
Authority: user project brief and Phase 0 design; not an independently verified Amazon rule.

## Context

The project spans a web interface, MCP service, orchestration and shared rules. A single language and explicit boundaries reduce contract drift.

## Decision

Use TypeScript and ESM on Node.js 24.x, pnpm workspaces with private packages, strict shared compiler settings, Prettier, ESLint and Vitest. Next.js/React, Zod and Playwright are planned for their relevant phases. Pin the package manager and direct tooling dependencies.

Phase 0.1 amendment (2026-09-26, explicitly requested by the user): standardize exclusively on Node.js 24.x, align Node type definitions to major 24, and retain pnpm 12.3.4. This supersedes the initial generic runtime baseline; no Node 22 support or test matrix is maintained.

## Consequences

Shared contracts can be checked together. Packages must declare future dependencies using workspace:\* and avoid cycles. Empty entry points establish boundaries without shipping product behavior. Framework-specific builds and browser tests are deferred.

## Alternatives considered

Separate repositories or a single undifferentiated app would add coordination cost or blur ownership.

Changes to this decision require a superseding ADR and explicit user agreement before implementation.
