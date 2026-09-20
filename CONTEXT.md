# Graft

Graft lets an agent running in someone's own harness acquire the tools it lacks: its coding model
authors a small module against a vendor's API, verifies it without changing anything, publishes it,
and promotes it into that agent's tool list, and later takes it out again when it goes unused.

## Language

### People and agents

**Person**:
The account holder. A person owns connections and the toolbox, and may run several agents. The
outermost boundary in the schema today; an org tier exists as a column so sharing can come later
without a migration.
_Avoid_: user (in schema and API names), customer, owner, tenant

**Agent**:
One harness connection to Graft, authenticating with its own token — a static bearer token the
harness carries, or the OAuth tokens an MCP client holds for it. An agent holds a scope and a
working set and nothing else of its own. A person with OpenClaw on a server and Hermes on a laptop
has two agents and one toolbox; a person who connects Claude has a third.
_Avoid_: harness (that is the software), client, bot, session, assistant

**Harness**:
The agent software a person runs, OpenClaw or Hermes today, or a chat product such as Claude or
ChatGPT, that Graft extends. Graft is a server the harness connects to over MCP, never a component
inside it.
_Avoid_: framework, runtime, client app, host

**MCP client**:
A harness in its OAuth role: the software that registers itself with Graft's authorization server,
sends the person to the consent page, and holds the tokens the consent issues. RFC 6749's "client",
kept to protocol code and the consent page, where it names the software that is asking — never an
agent, which is the record the client's tokens act as.
_Avoid_: app, connector (the products' word for the same thing), integration

### Connections and reach

**Connection**:
One vendor account a person has given Graft: its auth scheme, its credential, and the set of hosts
it may reach, and the provider it comes from. Credentials are write-only after entry.
_Avoid_: integration, app, account, provider (as a word for the vendor — a connection *has* a
provider, below)

**Connection provider**:
Where a connection comes from: the seam that decides how the person connects the vendor — a secret
form, a one-click link, or no person step — and what happens to a vendor request at call time —
inject a credential Graft holds, or relay to an upstream that holds it. The keyring provider is
every deployment's floor and covers every vendor; a deployment may enable others before it, in
order. ADR 0019.
_Avoid_: broker (that is a company, not the seam), backend, integration, source

**Relay**:
What the proxy does for a connection whose provider holds the credential elsewhere: the resolved
vendor request is rewritten into a request to the provider's upstream proxy, which injects the
credential and answers with the vendor's response. The vendor host is still the one the proxy
judged, the dry run still stops writes here, and the event still names the vendor path. A relay
scheme is one of the proxy's schemes and never one a person may choose.
_Avoid_: forward (what the proxy does with every call), proxy (the relay goes *through* one),
broker

**Scope**:
The connections an agent may use: every connection of the person's unless the person limits the
agent to a list (ADR 0007 as amended 2026-09-19). The capability token minted for an exec names
them, so an authored tool running for one agent cannot reach a connection that agent was never
given.
_Avoid_: permissions, toolkit, policy, grant

**Proxy**:
The one route from a sandbox to a vendor. It verifies the capability token, strips inbound
authentication, injects the connection's credential according to its scheme, pins the request to
the connection's declared hosts, refuses redirects and private ranges, and returns the vendor's
answer verbatim.
_Avoid_: gateway, broker, relay

**Capability token**:
A short-lived EdDSA JWT minted per exec naming the agent, the connections in reach, the tool, and
whether this is a dry run. Verified statelessly by the proxy.
_Avoid_: API key, session token, bearer (the per-agent token the harness holds is a different thing)

**Sandbox**:
Where authored code runs: a short-lived Docker container in the self-hosted form, a Blaxel sandbox
in the hosted form. Its only egress is the proxy. Packages are never installed inside it.
_Avoid_: container, VM, worker, isolate (as the name of the thing)

### Tools and the toolbox

**Tool**:
A single capability the harness sees as an MCP tool. Everything in an agent's list is either a
meta-tool or an authored tool. On the wire an authored tool is `<vendor>__<name>` — the two
kebab-case halves joined by a double underscore, which neither can contain — and a connection's
execute tool is `execute__<connection id>`.
_Avoid_: function, action, capability, skill

**Meta-tool**:
One of the fixed tools Graft's MCP server always exposes: `acquire`, `find_tool`, `promote`,
`demote`, `run_tool`, `request_connection` and `request_credential` (the two handoffs about a
connection's credential), and the low-level authoring set for agents that want to drive the loop
themselves.
_Avoid_: system tool, builtin, core tool

**Authored tool**:
A tool Graft's model wrote: a small module of code making one call against a connection, no more
of the vendor's API than the task needs. Versioned in the toolbox, bound to a connection's vendor
rather than a connection row, and promoted per agent.
_Avoid_: custom tool, generated tool, function, integration, script

**Toolbox**:
A person's store of authored tools, every version kept, demoted ones included. Nothing is ever
deleted by the system.
_Avoid_: library, registry, catalog, archive (the archived part of the toolbox is still the toolbox)

**Working set**:
The authored tools currently promoted for one agent, and therefore present in its MCP tool list.
Bounded by a cap and an idle window per agent.
_Avoid_: active tools, loaded tools, context, enabled tools

**Promote** / **Demote**:
Moving an authored tool into or out of an agent's working set, by the agent's own call, by the
cap and idle rule, or, for a demotion, by the revoke of the connection the tool is bound to (ADR
0009 as amended). Both fire `tools/list_changed`. A demoted tool stays in the toolbox and is one
`find_tool` call from coming back.
_Avoid_: enable/disable, load/unload, install/uninstall, delete

**Sweep**:
The scheduled pass that applies the cap and idle rule to each agent's working set: it demotes what
went unused past the idle window, then the least recently used beyond the cap, never a tool used
inside the window, and not at all while the agent has a run in flight. Every demotion it makes is
recorded with its cause, `idle` or `cap`, beside the agent's own.
_Avoid_: garbage collection, eviction, cleanup, expiry

### The loop

**Acquire**:
The asynchronous job in which Graft's model authors a tool: read the vendor's documentation, write
the module, check it, prove it with reads, publish with a test input, dry-run, fix and republish
until it passes, then promote. Returns progress while it runs and the tool when it is done.
_Avoid_: generate, build, create tool, install, author (as the job's name; the model authors, the
job acquires)

**Check**:
The static pass over a module: types against the input schema and the context, banned surface,
imports outside the module, a literal foreign host, an SDK not bound to the proxy. Also the source
of a tool's read-only and destructive annotations, derived from the methods it uses.
_Avoid_: lint, validate, compile

**Dry run**:
A run in which reads reach the vendor and every other method stops at the proxy, which answers
with a preview of the request that would have left. Exists for the model, which fixes the tool on
what it learns; a person is never shown one.
_Avoid_: test run, preview (that is what a dry run returns for a write), simulation

**Repair**:
An acquire run started because a published tool that used to pass has begun failing, against the
failing trace. Roadmap level L2.
_Avoid_: fix, heal, regenerate, self-heal

**Package policy**:
The rule deciding whether a package may be installed while a tool is being published: on the
allowlist of official SDKs, or carrying npm provenance and clearing an age and download threshold.
A package that fails it is not a blocked tool, only a blocked shortcut; the model writes the calls
by hand.
_Avoid_: allowlist (one part of it), whitelist, dependency check

### People in the loop

**Console**:
The web app where a person enters a secret, completes an OAuth consent — a vendor's, or an MCP
client's, which mints the agent the client will be — answers an approval, and sees each agent's
working set. The one channel to a human that works for every harness.
_Avoid_: dashboard, admin, portal, UI

**Handoff**:
A URL a meta-tool returns so the person does the next step in the console, pre-filled with
everything that is not secret. The agent relays it; the tool waits or polls.
_Avoid_: link, redirect, elicitation (which is a different mechanism, used only for approvals)

**Approval**:
A person's answer to a tool's ask. Reads never ask. Any other tool, destructive included, asks once
and the answer holds; the person may set a tool to ask every time, and back. `acquire` asks once
per agent per connection. Answerable later through the console.
_Avoid_: grant, permission, consent (fine in prose, not as the noun for the record)
