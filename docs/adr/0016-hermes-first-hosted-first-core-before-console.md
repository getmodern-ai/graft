---
status: accepted
---

# Hermes first, hosted first, core before console

The first release targets **Hermes**, because everything the design leans on is confirmed there:
it re-fetches on `tools/list_changed`, it raises MCP elicitations, it speaks MCP OAuth 2.1, and it
carries bearer headers to a remote server. **OpenClaw follows** once its header-forwarding bugs and
its handling of the notification are re-checked. The **hosted form launches first** with the
**Docker image released beside it**, because the image is also the development environment
(ADR 0002).

The launch slice: `acquire` running asynchronously with L1 retries, dynamic first-class tools over
MCP with the generic runner fallback, key-shaped auth plus guided BYO OAuth, the console for
secrets and approvals, the per-agent working set with cap and idle demotion, and the thin Hermes
skill. L2 and L3 exist as roadmap issues on day one (ADR 0012).

The build order, each step the test bed for the next:

1. **Core extraction into this repository**: proxy with multi-host connections, capability token,
   vault behind a keyring seam, checker, runner, dry run, authoring skill, eval scenarios, with
   both backings per seam from the start.
2. **Person-owned, agent-scoped tenancy and the console**: accounts, agents with bearer tokens,
   connections, the credential handoff form, the pending-approval page, the working-set view.
3. **The MCP server**: meta-tools, dynamic tool list, generic runner, annotations from the checker,
   the approval model.
4. **`acquire` with the inner model**: asynchronous job with progress, L1 retries, publish,
   promote, notify, then the thin Hermes skill.
5. **Guided BYO OAuth**, then a private alpha with a handful of Hermes users, then OpenClaw.

## Considered options

- **Both harnesses at launch.** Rejected: twice the client-quirk surface before anyone has used
  either.
- **Self-host first, hosted later.** Rejected: it delays the form that produces revenue and the
  traces L3 needs.

## Consequences and accepted risks

- **Effort is a range, not a date.** Steps one to four are mostly relocation and reshaping of
  tested code; the infrastructure around them is the work. Six to eight weeks to a hosted private
  alpha is the planning range, with the OAuth step and the Docker egress design the two items most
  likely to run long.
- **Hermes first means the first users are the most technical ones.** Accepted; they are also
  the ones who will read the ADRs.
