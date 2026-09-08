---
status: accepted
---

# A working set contracts by rule

Expansion has an author. Contraction, in every harness today, has none, which is how a tool list
becomes the kitchen sink by another route. Graft gives it two:

- **The agent may `promote` and `demote` explicitly.** The skill tells it to demote what it no
  longer needs.
- **A rule is the backstop.** Each agent's working set has a **cap** and an **idle window**, both
  per agent and editable in the console. A tool unused past the window, or the least recently used
  one when the cap is hit, is demoted automatically and `tools/list_changed` fires.

Two guards make the rule safe. **Demotion is deferred while the agent has a run in flight**, and
it never touches a tool used inside the current window, so the monthly job whose tool was demoted
degrades to one `find_tool` and one `promote` rather than to a failure. **Nothing is ever deleted
by the system.** A demoted tool stays in the person's toolbox with all its versions, and comes
back in one call.

Defaults start with a cap in the low tens and an idle window of a few weeks, and move with the
data.

## Considered options

- **Agent-driven only.** Rejected: models are poor at cleaning up, so the set only grows.
- **Automatic only.** Rejected: the agent often knows a tool is done before any window elapses,
  and saying so is cheap.

## Consequences and accepted risks

- **The per-tool usage and failure records that drive demotion are the same records a
  self-improvement miner reads later** (ADR 0012). Contraction and improvement share one ledger,
  written from the first run.
- **A demoted tool is one round trip away, not zero.** Accepted; the alternative is a list that
  never shrinks.
- **One addition was raised in the design session and not captured**, and is carried as a roadmap
  item to be specified; see `docs/roadmap.md`.
