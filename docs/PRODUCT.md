# Product intent

**Verified requirement — user brief:** ClientOps Command will support evidence-backed client operations through multi-tool agent workflows, persistent operational state, human-controlled write actions and auditable execution.

**Planned implementation:** an operator asks about a client situation; the agent reads authorized operational records, explains findings with evidence references and proposes an internal change. A human reviews the exact change through the application. Only a deterministic server check can authorize its execution. The resulting business state and execution evidence remain available after process restart.

Candidate v1 records include organizations, memberships, clients, work items and operational notes. These are planning concepts, not finalized schemas. Select a narrow synthetic scenario before implementing domain contracts.

Success will mean the operator can trace each claim to authorized evidence, distinguish a proposal from a completed change, reject a proposal without mutation, and inspect an execution outcome. Refusal and insufficient-evidence cases should be visible, not hidden behind confident prose.

**Architectural decision:** EXTERNAL and DESTRUCTIVE actions are outside v1. No emails, payments, third-party writes or deletion workflows. Agent memory cannot override business records.

**Future/optional work:** MCP Apps, additional integrations and broader workflow coverage require separate authorization. Phase 0 implements none of the product behavior above.
