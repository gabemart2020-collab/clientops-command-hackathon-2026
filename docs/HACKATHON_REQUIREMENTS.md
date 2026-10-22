# Requirements and provenance

## Classification and sources

- **Verified requirement:** established by the user's brief or a cited primary source, with its authority stated.
- **Architectural decision:** the project's selected approach; not an Amazon mandate.
- **Planned implementation:** required or intended behavior that is not yet built.
- **Future/optional work:** outside the currently authorized scope.

External requirements below were verified on 2026-09-26 against the [official rules](https://amazonappdev2026.devpost.com/rules), [submission overview](https://amazonappdev2026.devpost.com/) and [official FAQ](https://amazonappdev2026.devpost.com/details/faqs). The Phase 0.1 user brief confirms this project's submission commitments.

## Verified competition requirements

| Item                       | Requirement                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Competition                | Amazon Build, Ship, Shape Developer Hackathon 2026                                                                                                                                         |
| Deadline                   | October 23, 2026 at 12:00 PM Pacific Time (PDT)                                                                                                                                            |
| Alexa+ technical route     | A working Agent Skill or a self-hosted MCP server using MCP 2025-11-25 or later over Streamable HTTP                                                                                       |
| Repository                 | GitHub repository containing source code, assets and instructions needed to run the project                                                                                                |
| Runtime use                | For our Alexa+ technical route, required technology must actually be called/loaded at runtime; documentation-only mentions do not qualify                                                  |
| Demo                       | Public English YouTube or Vimeo demonstration video under three minutes                                                                                                                    |
| Feedback                   | Product feedback for each Amazon tool, API and SDK used                                                                                                                                    |
| AWS Builder mini challenge | A primary-track project using qualifying AWS services such as Bedrock, AgentCore or Strands SDK with documented integration qualifies; describe services and their use in product feedback |

Sources: [rules](https://amazonappdev2026.devpost.com/rules) and [submission overview](https://amazonappdev2026.devpost.com/), verified 2026-09-26. Our English, under-three-minute commitment follows the user brief; the rules permit English translations and state judges need not watch beyond three minutes. The rules also describe a separate simulated Alexa+ route; that route is not selected for ClientOps Command.

## Verified private-repository option

A private submission repository may be shared with the designated Amazon/Devpost reviewers near submission time, before the deadline. The FAQ identifies Amazon reviewers chris-trag, knmeiss, giolaq, anishamalde, mosesroth and emersonsklar, plus Devpost at testing@devpost.com. Invitations must be accepted and expire after seven days; arrange access around submission and verify it then. This is permission in the competition rules, not authorization for an agent to invite reviewers now. [Official FAQ](https://amazonappdev2026.devpost.com/details/faqs), verified 2026-09-26.

## Project decisions and implementation status

**Architectural decisions / user-selected scope:** primary track Alexa+; self-hosted MCP server; pinned competition baseline `2025-11-25`; Streamable HTTP. A newer permitted protocol is not an instruction to upgrade. The project uses TypeScript, Node.js 24.x and pnpm workspaces, with the remaining intended stack documented in ARCHITECTURE.md and AGENTS.md.

**Alexa+ MCP runtime requirement: IMPLEMENTED LOCALLY / VERIFIED (2026-09-28).** Phase 1 runs the official MCP server and client at runtime over real HTTP; automated tests verify initialization at 2025-11-25, tool listing and status-tool invocation. See [protocol test evidence](MCP_PROTOCOL.md). This is infrastructure proof, not SUBMISSION READY, AWS DEPLOYED or AGENTCORE VERIFIED.

**Planned implementation:** meaningful ClientOps functionality, qualifying AWS integrations, product feedback and demo/submission evidence. Planned AWS adoption alone does not establish completed AWS Builder qualification.

**Verified requirement — current user brief:** Phase 1 is limited to local MCP protocol proof and CI on phase/1-mcp-proof. Only the reviewed baseline may be pushed if absent remotely; it was already present. No Phase 1 push, merge, reviewer invitation, deployment or Phase 2 work is authorized.

Individual entrant eligibility and final submission readiness must still be checked before submission. Do not infer additional Amazon mandates or claim implemented capabilities from these documents.
