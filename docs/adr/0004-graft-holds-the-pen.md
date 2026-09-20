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

## Amendment 2026-09-20: a chat product's agent holds no pen at all

Measured live on 2026-09-20 with a fresh account on both chat products (GRA-125): a Claude.ai agent
asked for the weather called the connection's `execute__` tool for Open-Meteo instead of `find_tool`,
so the person was asked to approve building for code the chat model would run by hand while a
finished weather tool sat in the toolbox; a ChatGPT agent abandoned a running `acquire` job after
seven status polls and answered by writing and running its own code through `write_file` and
`execute__`, with the person's Gmail credential injected. Both are the chat model taking the pen this
decision gives to Graft's model, and the instructions telling it not to did not hold.

So the authoring set — `write_file`, `read_file`, `run_command`, `wait_for_process`,
`read_web_page`, `check_tool`, `publish_tool`, `read_tool_source` — and every `execute__<connection>`
tool are listed for an agent its person drives by hand, a harness under a static token (the Hermes
skill's "author by hand" case), and for no agent a chat product holds over OAuth (ADR 0018). A chat
product's agent lists the meta-tools and its promoted tools; a call to a hidden tool is refused
`advanced_tools_hidden` by name (`packages/mcp/src/by-hand.ts`). Since such an agent no longer
learns a connection's id from an `execute__` tool's name, `find_tool` answers `connections` — every
live connection in the agent's scope with the `connectionId` `acquire` takes. A console setting that
opens the set for a chat product's agent whose person wants to author by hand is a later ticket;
until then the static token is that door.
