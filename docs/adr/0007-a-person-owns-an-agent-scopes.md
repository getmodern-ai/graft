---
status: accepted
---

# A person owns, an agent scopes

**Connections and the toolbox belong to the person.** A credential is entered once and a tool is
authored once, however many harnesses the person runs. **Each harness connection is an agent**
holding two things of its own: a **scope**, the connections it may use, and a **working set**, the
tools currently promoted into its list (ADR 0003). Expansion and contraction happen per agent.
Credentials and code do not.

The scope is where the security property lives: the capability token minted for an exec names the
agent and the connections its scope allows, exactly as Cando's names the app, so an authored tool
running for one agent cannot reach a connection that agent was never given.

**An org tier exists in the schema from the first table and has no UI.** Every row is
person-owned at launch. Executor.sh's rework plan records the lesson: carry the owner-tier column
from day one so that sharing later is a column, not a migration.

A harness authenticates to Graft with **a bearer token per agent**, which both OpenClaw and Hermes
can carry in the `headers` block of a remote MCP server today. **MCP OAuth 2.1** is offered to
clients that speak it; Hermes does, OpenClaw has it as an open feature request.

## Considered options

- **Person-centric, nothing per harness.** Rejected: the working set must be per agent or the
  product's whole claim, that the harness fits the work, fails the moment a person runs two agents
  with different jobs.
- **Agent-centric, Cando's model, each agent its own connections and toolbox.** Right for tenant
  isolation inside a multi-user product; wrong here, where the same person would enter Gmail per
  agent and author the same tool twice.

## Consequences and accepted risks

- **Revoking a connection affects every agent of the person** at once, and every tool bound to
  that connection's vendor stays published and re-asks after reconnection, as in Cando.
- **Two agents may hold the same tool in their working sets** with different approval states
  (ADR 0008); approval is per agent, per tool.
- **Bearer tokens in a config file are the weakest link.** They are per agent so one leak
  revokes one agent, and OAuth 2.1 replaces them wherever the client allows.

## Amendment 2026-09-19: a person's connections reach every agent of theirs unless the person narrows one

Decided by Aleks (GRA-105), after his Claude.ai test of 2026-09-19 hit GRA-104: "I am not sure how
many people will have multiple agents, but I can see how a person that has done a connection to
Gmail and authored a tool, say in ChatGPT, will expect it to just be available everywhere." Until
this amendment a connection was in the scope of the agent that proposed it and of whichever agents
the person ticked, and an agent minted later by another product saw nothing until the person
visited its page — while every tool in the toolbox was already the person's and appeared in
`find_tool` for every agent (ADR 0003), so an agent could find a tool it could not run.

**An agent's scope has a mode.** `all`: every connection of the person's, present and future — the
default for a new agent, whichever door minted it (the console's create, an MCP client's consent).
`listed`: the connections the person ticked or the agent's own proposals added — every agent's
scope as it was before this amendment, and what a person chooses on the agent's page when they
deliberately separate agents: a bot on a shared server from a laptop harness, a work account from a
personal one. Every agent that existed when the amendment landed keeps its list (migration 0009
writes `listed` on the rows it finds), so nothing widened silently for anyone; new rows take the
column's default, `all`.

**What is kept.** The property this ADR states is kept by construction: the scope is resolved to a
set of connection ids before any capability token is minted (`getAgentScope`, one statement under
the person for either mode), and the token still names those ids and no others. A grant into the
scope after a connect — the console's submit, a link's return, the gateway's no-person-step connect,
the `scope` ask's yes — is a no-op for an agent on `all`, since the row is the person's and
therefore already that agent's. Approvals do not move (ADR 0008): the build approval and the first
use of a tool that is not read-only still ask once per agent per connection, which is the step that
protects a person from a new agent acting through an old connection. Revoking a connection still
reaches every agent at once; the agents whose tool list a revoke changes now include every agent on
`all`.

**Why default open and not the two alternatives.** Keeping per-agent scope and making the ask
painless (GRA-104) is one click — on every new agent, for every connection. Defaulting open only for
agents a chat product's consent minted, and listed for static-token agents, is a heuristic on how
the agent was made, which is not what the person is deciding. The person is the boundary
(CONTEXT.md, *Person*); the agent is a harness of theirs; separation is theirs to ask for, on the
agent's page, and visible there. GRA-104's `scope` ask stays worth having for a narrowed agent and
stops being the everyday path.

## Amendment 2026-09-20: a tool follows its vendor's reconnected connection

Decided under GRA-122, from a live check of 2026-09-20: both Gmail rows revoked, Gmail connected
again from a chat through a link provider, and every Gmail tool dead — `run_tool` answered
`connection_revoked`, and `acquire`'s job burned two attempts dry-running new versions against the
revoked default. The consequence above, "every tool bound to that connection's vendor stays
published and re-asks after reconnection", held only when the reconnection kept the row's id, and a
link provider's reconnect-in-place demanded the same primary host and the exact host set, so a
second proposal spelling `…/gmail/v1` with one more host made a new row beside the released one.

**The connection's identity survives a revoke and a reconnect of the vendor through the same
provider, whatever hosts the second proposal names within the provider's coverage**: the released
row is the match, its hosts grow to the union, its primary host and name stay (the proxy prepends
the primary host's path to every module path, so moving it would break the tools kept), and the
most recently revoked row is chosen when several qualify. **And a tool's binding follows the
vendor** where the reconnection made a new row anyway: a run against a revoked default goes to the
one live, usable connection of the tool's vendor in the agent's scope and rebinds the tool to it;
with several such connections the refusal names them and the choice is the person's; a caller that
names the connection — `acquire`'s dry run names the job's — is never followed, and the job's
publish rebinds an existing tool row to the job's connection before the dry run. The scope is read
before the choice, so the property this ADR states is kept: an authored tool running for one agent
still reaches no connection that agent was never given. The approval grain does not move (ADR
0008): the tool re-asks on the connection it now runs against, as it did after any reconnection.
