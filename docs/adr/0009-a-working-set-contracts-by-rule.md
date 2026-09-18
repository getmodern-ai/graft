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

## Amendment 2026-09-18: a tool of a revoked connection leaves the working set because it cannot run

Decided by Aleks (GRA-69), as the orchestrator's default, open to being overruled on the ticket.
Revoking a connection (ADR 0007) now **demotes, for every agent of the person at once, every
promoted tool bound to that connection**, and records each demotion with a third rule cause,
`revoke`, beside `idle` and `cap`. The connection's `execute__` tool leaves the same lists in the
same moment, and every live session of an affected agent hears `tools/list_changed`, as it does for
the agent's own `demote` and the sweep's.

**Why demote rather than annotate or leave alone.** A tool whose connection is revoked cannot run:
its credential is gone, and the proxy refuses it whatever the agent tries. A list that keeps offering
it is the kitchen sink this decision exists to prevent, and `request_connection` for the same vendor
was already answering `connection_revoked`, so the list and the meta-tool disagreed. Annotating the
description instead would keep a tool in the list that the annotation says not to call, which is
the same list one sentence longer.

**Why a cause of its own.** The history the console shows is the record a later miner reads (ADR
0012), and a demotion the person caused by revoking is not a demotion the rule made for disuse: the
tool was in use, or would have been, the moment before. `revoke` says the tool left because it could
not run, not because it was unwanted. The enum had reserved the word since the working set was
first tabled; this amendment is the first writer of it.

**Unchanged.** Nothing is deleted. The tool stays in the person's toolbox with every version,
`find_tool` still finds it, `promote` brings it back into a list even while the connection is
revoked, and it runs again once the person reconnects the connection, which clears the revocation
stamp and returns the `execute__` tool to the list by itself. The scope grant stays too, so
reconnection is one step in the console and none on the agent's page. The approvals a revoke deletes
stay deleted; a tool brought back asks again, as ADR 0007 says.
