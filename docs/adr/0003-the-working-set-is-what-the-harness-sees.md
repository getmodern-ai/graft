---
status: accepted
---

# The working set is what the harness sees

Graft's MCP server advertises the fixed meta-tools plus **exactly the authored tools currently
promoted for the connecting agent**, as ordinary first-class MCP tools with real schemas. When the
agent promotes or demotes a tool, or `acquire` publishes one, the server fires
`notifications/tools/list_changed` and the harness re-fetches the list. Expansion and contraction
are therefore literal: the model's context holds the current working set and nothing else.

A generic `run_tool` meta-tool stays beside the first-class tools for two cases: the turn in which
a tool was just published, before the harness has re-fetched, and any client that ignores the
notification. Cando solved the same same-turn problem the same way with `run_published_tool`.

Hermes is confirmed to re-fetch on the notification, lock-protected against rapid fire, and lets a
person filter a server's tools with an `include` list. OpenClaw's client speaks streamable HTTP
since version 2026.3.13; its handling of the notification is unconfirmed and is checked before
OpenClaw becomes a launch target (ADR 0016).

## Considered options

- **A constant-size meta-toolset only**, every authored tool called through the generic runner.
  Rejected as the primary shape: one indirection on every hot-path call, and the model works from a
  description it fetched rather than a schema the harness validated. Kept as the fallback.
- **Materialising authored tools into the harness's native plugin slot** (OpenClaw's `tool.json`
  plus `index.js`, Hermes plugins). Rejected: a packager per harness on two release schedules, and
  the harness's own runtime still has to reach Graft's proxy, so Graft is in the call path
  regardless.

## Consequences and accepted risks

- **Tool-list churn is a first-class event.** Every promote, demote and publish is recorded with
  its cause, and the notification is rate-limited per agent.
- **A client that never re-fetches sees a stale list.** It still works through `run_tool`, and
  `find_tool` tells the agent what exists.
- **The working set is per agent** (ADR 0007), so two harnesses of one person may see different
  lists over one toolbox. That is the intent.
