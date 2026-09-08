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
