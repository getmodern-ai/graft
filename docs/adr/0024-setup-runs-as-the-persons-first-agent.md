---
status: accepted
---

# Setup runs as the person's first agent

**Setup** is the console's guided first run (CONTEXT.md): a person names the harness they run,
connects a starter vendor, has Graft acquire a small read-only tool and run it, and leaves with the
prompt that connects that harness. Decided with Aleks on 2026-09-23 (GRA-202) after the first two
dozen sign-ups every one left an empty console within minutes, and none made a connection or ran
`acquire`. Three of its decisions are the kind a later reader would otherwise "fix", and this record
holds them.

**Setup runs as a real agent, minted first.** Every step Setup takes — the connection ask, the build
approval, the acquire job, the run — is a function that already exists behind the MCP door and takes
an agent's scope. Rather than invent a per-person "console agent" and move the tool into the real
agent later, the harness step mints the person's first agent for the harness they picked, and every
later step runs as it, so the tool is promoted into the working set the harness will find. The agent
is minted with **no token and no client**: it is **awaiting its harness**, a state read off the row
(active, no token hash, no client id) and never a column. For a chat product, the consent later
names it — an OAuth agent may therefore exist before its consent, which amends ADR 0018 below. For a
static-token harness the token is minted at the finish step, not the harness step, because a
plaintext exists only at mint and a reload would lose it; the route that issues it admits only an
agent awaiting its harness.

**The console is a second caller of `acquire` and of a run, beside MCP.** Until this record every
acquire job and every run was started by a harness over `/mcp`. Setup adds routes under the console's
session that call the same core and `@graft/mcp` functions with the agent's scope: the connection
routing `request_connection` performs, split from the wait that follows it; the build approval's
grant and the job's creation; a read of the job; a synchronous run of an authored tool that admits
only a read-only tool in the agent's working set. The run route is general in shape and Setup is its
only caller; a Run action anywhere else in the console is a later decision, not a consequence of this
one. ADR 0004 is untouched: Graft's model still holds the pen, and the person's clicks still carry the
intent.

**Build is the build approval.** `acquire` asks a build approval once per agent per connection (ADR
0008). In Setup the person is in the console pressing a button labelled Build, so that press records
the approval through the function the pending-action card calls, and no pending action is opened.
The channel is the console, which ADR 0006 names, and the grain does not move; the ask and the
answer merely happen in one click.

## Considered options

- **A conversational Setup, Lemonade's shape.** Rejected for the first version: ADR 0006 opens with
  "the person is not in a chat with Graft", it would need a conversational model endpoint the
  server does not have, and the one place a model genuinely helps — proposing a first goal for a
  vendor — is a single structured call on the triage model. A stepper with model-proposed goal chips
  keeps the pacing without the transcript.
- **A per-surface Setup: one in the console, one driven by the chat product's model.** Rejected: the
  chat model cannot be driven, only handed a link, and the console already has the popup, the
  `from=card` close and the self-closing page a door needs. One Setup, entered from the console's
  first run and from a `find_tool` handoff on an agent whose person has no connection.
- **A canned starter tool copied into the toolbox.** Rejected: it demonstrates nothing the product
  does and would be the one tool in the toolbox nobody authored. The job is asynchronous with
  progress already; Setup shows the lines.
- **Ending the consent page in Setup.** Infeasible: the consent must redirect to the client's
  redirect URI at once, since the chat product's popup or the CLI's listener is waiting for the code
  and Claude closes the window on arrival. The in-chat handoff replaces it.

## Consequences and accepted risks

- **A seven-vendor starter list sits beside ADR 0001.** It is a convenience for the first five
  minutes with one curated read each, filtered to what the deployment's providers can connect with
  at most a pasted key, never a catalogue; *Another vendor* is the ordinary form, one click away.
- **A person can hold an agent that no harness ever connects.** It shows as *Awaiting harness* on the
  agents table and is revoked like any other. The consent card pre-selects the person's one such
  agent and falls back to *A new agent* with none or several, so a second agent by accident is the
  person's choice, not the default.
- **Setup's acquire costs model spend per sign-up** in the hosted form. Accepted; the alpha's credits
  cover it, and one job per person is the bound Setup keeps.
- **`SERVER_INSTRUCTIONS` does not change.** The budget stands at 2,039 of 2,048 characters; the
  in-chat door is a fact in `find_tool`'s description, and the model only relays a link.

## Amendment, 2026-09-24: integration and task, and one-click starters (GRA-216)

Aleks's walkthrough of Setup on 2026-09-24 changed three things this record's text predates, and
the text above is left as it was decided. **The person-facing word is integration**, not vendor:
Setup's steps, the console's connection screens and the ask card say integration, and a connection
is one account of an integration (CONTEXT.md, *Integration*); code identifiers and model-facing text
keep vendor. **The step that names the first tool's work is the task step**, not the goal step; the
record's step value stays `goal`, as `vendor` does. **The starter vendors are starter integrations,
and they are one-click only**: common services a link provider connects by OAuth (Pipedream on
Cloud), plus Open-Meteo, the keyless one; a starter the deployment could connect only with a pasted
key or an operator's own OAuth client is never offered, so the keyring alone offers Open-Meteo
alone. *Another integration* is still the ordinary form. The consequence above that reads
"filtered to what the deployment's providers can connect with at most a pasted key" is superseded
by that rule; the list is still a convenience beside ADR 0001, never a catalogue.
