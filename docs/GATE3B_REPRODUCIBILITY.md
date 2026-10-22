# Gate 3B — Fresh-Runner Demo Reproduction

**Status:** Passed on the original development repository in PR #19. This independent submission snapshot requires a new CI run on its own release commit. No public deployment, AWS access, or submission is authorized.

## Isolation and setup

The dedicated `.github/workflows/gate3b-reproduce.yml` runs from a fresh GitHub-hosted Ubuntu 24.04 runner on pull requests that change this workflow or its test/documentation. GitHub token permission is `contents: read`, and there are no AWS or database secrets, external service credentials, artifact uploads, or exposed public ports.

It checks out a clean repository snapshot, installs Node.js 24 and pinned pnpm 12.3.4 with the frozen lockfile, builds local workspace libraries, and creates a **new disposable PostgreSQL 16 Docker container**. It refuses to proceed if a `clientops-postgres` container already exists on that runner. `pnpm demo:reset` then initializes the _disposable localhost database only_, applying migrations and synthetic Acme Labs data. This command is destructive and must never be used against Codespaces, Supabase staging, production, or any persistent dataset.

Local MCP starts on `127.0.0.1:3001`; Next.js starts on `127.0.0.1:3000`. AWS environment credentials are unset; the configuration uses non-existent AWS profiles, disabled metadata access, explicit localhost database configuration, and both web-action-write flags set to false. The runner has no application AWS permissions and is not supposed to invoke a model.

## Browser assertions

The dependency-free `scripts/gate3b-webdriver.mjs` uses runner-provided Google Chrome and matching ChromeDriver. It checks:

- `/demo` loads and displays the application.
- Changing the selected account and switching agentic/deterministic modes triggers **zero** agent or orchestration API requests.
- Exactly one click on **Prepare Executive Review** triggers exactly one `POST /api/orchestrate`, returns HTTP 200, and triggers no `POST /api/agent`.
- The Acme Labs deterministic briefing shows `AT RISK`, at least two risk findings, at least three talking points, an expandable authoritative evidence drawer, and two successful MCP trace entries.
- Any missing browser evidence or failed request fails the job. The test emits only limited pass/fail text, without screenshots, raw request bodies, response data, credentials, or artifacts.

The shell trap terminates application processes and removes the disposable database container. This job does not replace the regular `pnpm validate` + production-build workflow.

## Certification boundary

A green Gate 3B job demonstrates clean-install, seeded, **deterministic** browser reproduction only. It does not prove a judge has working Bedrock credentials, live model behavior, a deployed Alexa+ skill, production authentication, or public publication readiness. Historical source/log exposure, third-party rights, repository protections, and public/private reviewer access remain separate gates.
