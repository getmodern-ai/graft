# Roadmap

Settled in the design session of 8 and 9 September 2026. Every decision is an ADR under
`docs/adr/`; this file is the order of work and the list of things deliberately later. Each item
below becomes a Linear issue in the Graft project; the identifiers are filled in once the issues
exist.

## Build order (ADR 0016)

| Step | Deliverable | Ticket |
| --- | --- | --- |
| 1 | Core extraction: proxy with multi-host connections, capability token, vault behind a keyring seam, checker, runner, dry run, authoring skill, eval scenarios; Docker + local keyring + filesystem backings in this repo, Blaxel + KMS + S3 in the private package | |
| 2 | Tenancy and console: persons, agents with bearer tokens, connections, credential handoff form, pending-approval page, working-set view; org tier column, no org UI | |
| 3 | MCP server: meta-tools, dynamic tool list with `tools/list_changed`, generic `run_tool`, checker-derived annotations, the approval model of ADR 0008 | |
| 4 | `acquire`: asynchronous job with progress, L1 retries, publish, promote, notify; the thin Hermes skill | |
| 5 | Guided BYO authorization-code OAuth; private alpha with Hermes users; OpenClaw re-check and second target | |

## Self-improvement levels (ADR 0012)

| Level | What | When | Ticket |
| --- | --- | --- | --- |
| L0 | Static check, dry run, test input, outcome per version | Launch, in step 4 | |
| L1 | Retry with a changed module inside one `acquire` when a dry run fails | Launch, in step 4 | |
| L2 | Repair: watch per-tool failure rate, re-run `acquire` against the failing trace, republish; read-only keeps approval, write asks again once | First feature after launch, needs weeks of failure data | |
| L3 | Harness mining: cluster failed authoring runs across customers, propose edits to the skill, prompts and checker, accept only on non-regressing evals | Internal weekly practice from the first week; recurring issue with an owner | |
| L4 | The outer agent's skills and instructions as edit surfaces | Never | |

## Deferred, with the condition that brings each forward

| Item | Decision | Brings it forward | Ticket |
| --- | --- | --- | --- |
| Google first-party OAuth client on the hosted tier | ADR 0005 | People observed connecting Google through the guided BYO path; budget for verification plus annual CASA | |
| TLS-terminating egress proxy for SDKs that cannot rebase | ADR 0010 | An acquire run failing for want of it more than occasionally | |
| Curated package mirror for the hosted sandbox | ADR 0013 | Hosted launch | |
| MCP OAuth 2.1 for the harness to authenticate to Graft | ADR 0007 | Hermes at launch if cheap; OpenClaw when its client supports it | |
| Elicitation for approvals where the client supports it | ADR 0006 | Step 3, behind a capability check | |
| Working-set addition raised in the design session, not captured | ADR 0009 | Aleks restates it; then spec | |
| Pricing revisit | ADR 0014 | The first hundred acquisitions counted | |
| Licence review | ADR 0015 | Community reaction in the first months | |
| Cando adopts Graft as a dependency | ADR 0011 | Graft's core API stable | |
| Org tier UI and sharing | ADR 0007 | A customer asks | |

## Out of scope, and why

- **An integration catalog or a broker.** ADR 0001.
- **Acting as an MCP gateway in front of other servers.** ADR 0001.
- **Credentials handed to the sandbox as data.** ADR 0010, never.
- **Editing the outer agent's skills.** ADR 0012, L4, never.
- **A plugin system for third-party backings.** ADR 0002.
