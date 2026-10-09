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
- **The loop is the hard part.** Reading a vendor's documentation, writing a module that reaches it
  only through the proxy, proving it with reads, stopping its writes until a person has said yes and
  promoting it into a working set that later contracts is the whole product, and every one of those
  steps can fail quietly. The rest of this record is how each is made to fail loudly or not at all.

## Amendment 2026-10-09: the basics are authored ahead of time (ADR 0025)

Decided by Aleks (GRA-220). Graft now ships **stock tools**: an integration's basics, authored once
by this loop as a build step, verified and reviewed, and offered to every person (ADR 0025). That
narrows two lines above and leaves the rest standing. "No integration catalog" now means no
catalogue of someone else's tools: stock is Graft's own authored code, run in the sandbox through
the proxy, and nothing upstream is swallowed whole. "Every vendor is reached the hard way" still
holds, ahead of time and once for the basics, and at `acquire` time for everything else. Graft still
holds no credential for a broker and acts as no MCP gateway in front of other servers.
