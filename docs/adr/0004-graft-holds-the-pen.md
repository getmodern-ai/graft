---
status: accepted
---

# Graft holds the pen

The code of an authored tool is written by **a coding model inside Graft's own service**, not by
the model driving the person's harness. The harness calls one meta-tool, `acquire`, with the goal,
the vendor and any hints, and Graft runs the loop it inherited from Cando: read the documentation,
write the module, check it, prove it with reads, publish with a test input, dry-run, fix and
republish until it passes, promote, notify. `acquire` is **asynchronous**: it returns a job with
progress rather than blocking an MCP call for minutes.

What never moves inside: **intent and consent stay with the person and their agent**. The outer
agent decides what is needed. The person enters credentials (ADR 0006) and answers approvals
(ADR 0008). The first real write goes through the outer agent invoking the published tool, never
through Graft's model.

The low-level meta-tools, write, check, dry-run, publish, remain available as an advanced surface
for a person running a strong model who wants their own agent to drive.

## Considered options

- **The harness's model authors, guided by a skill Graft publishes.** Cando's shape today.
  Rejected as the front door: quality is whatever model the person runs, often a cheap or local
  one; the skill must be installed and kept current in two ecosystems; and the traces belong to
  the customer, so Graft can never try more than one candidate or learn from failures.
- **Only the high-level tool, no advanced surface.** Rejected: it costs little to keep and it is
  how Cando's own agents will use the core (ADR 0011).

## Consequences and accepted risks

- **Graft pays for tokens in the hosted form**, which is what makes acquisition the unit of price
  (ADR 0014). Attempts are bounded by count and by a token ceiling.
- **Vendor documentation and dry-run read responses pass through Graft's model provider** in the
  hosted form. Disclosed in the privacy policy; avoided in the self-hosted form, where the person
  brings their own model key.
- **This is what makes ADR 0012 possible.** With the authoring traces in Graft's process, failure
  mining and candidate proposals across all customers become reachable; with the customer's model
  holding the pen they never would be.
- **A long-running MCP tool call is a client-compatibility risk.** The job pattern with progress is
  the design; a blocking variant with a short timeout exists only for tiny acquisitions.
