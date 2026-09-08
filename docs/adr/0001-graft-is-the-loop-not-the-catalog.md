---
status: accepted
---

# Graft is the loop, not the catalog

Graft is one thing: the loop in which an agent, running in a harness its person already operates,
acquires a tool it lacks by having a model research the vendor and author the smallest module that
does the job, verified before use, and later sheds what it stops using. Graft ships **no
integration catalog**, **no credential broker**, and **does not act as an MCP gateway** in front of
other servers. An MCP server, like a vendor's REST API or SDK, is a source the agent may carve a
slice from; it is never swallowed whole into the agent's context.

The target customer is a person running their own agent in **OpenClaw** or **Hermes**. Both load
tools from an `mcpServers` block and from plugins, both pay per token for whatever those servers
expose, and both communities already talk about self-improvement at the skill level. Nobody offers
it at the code level with the credential kept out of the code and the tool verified before the
first real call. That is the gap.

## Considered options

- **An end-user MCP gateway with a broker behind it**, executor.sh's ground plus Pipedream's
  catalog. Rejected: it competes on catalog breadth, which brokers already own, and it sells the
  kitchen-sink model the bet is against.
- **An integration runtime sold to agent builders as an API**, the Composio and Nango field.
  Rejected as the front door: the differentiator is invisible there. Cando remains a consumer of
  the core (ADR 0011), which keeps that door available without making it the product.
- **Both doors at once.** Rejected for the launch; it doubles the surface before anyone has used
  either.

## Consequences and accepted risks

- **The demo is the loop, not a logo wall.** Marketing cannot list "2,000 apps". It shows one
  agent acquiring one Gmail tool in a few minutes.
- **Every vendor is reached the hard way**, by reading its documentation at acquire time. Vendors
  without public documentation are out of reach, deliberately.
- **Dropping the broker drops brokered OAuth.** Authorization-code OAuth becomes Graft's problem;
  ADR 0005 answers it.
- **Executor.sh's own history is the warning.** Its custom-tools plugin, the nearest thing to this
  loop, was merged in July 2026 and deleted three weeks later as "coming back better". The loop is
  hard to get right; the rest of this record is how.
