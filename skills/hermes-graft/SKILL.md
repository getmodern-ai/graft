---
name: hermes-graft
description: Acquire a tool you lack through Graft. When the person asks for something no tool in your list covers, call Graft's acquire against one of their connections, relay the handoff link it may answer with, describe an approval in the person's terms, and read acquire_status until the tool lands in your list. Never ask the person for a secret in chat.
version: 0.1.0
license: MIT
metadata:
  hermes:
    tags: [graft, mcp, tools, integrations, vendors]
    category: integrations
---

# Graft: acquire the tool you lack

Graft is an MCP server you are connected to. It holds the person's **connections** — vendor accounts
they gave it, credential and all — and a **toolbox** of small **authored tools**, each making one
call against one vendor. Your tool list from Graft is your **working set**: the tools promoted for you
right now, callable directly, plus a few fixed ones. When a tool you need is not there, Graft's own
coding model writes it: that is `acquire`. You decide what is needed; Graft's model writes and proves
the code; the person enters secrets and answers approvals in Graft's **console**, never through you.

## When to call `acquire`

The person asks for something against a vendor — an order in their inventory system, a page in
their wiki, a report from their accounting app — and no tool in your list does it. In this order:

1. **Call `find_tool` first**, with a few words about the task as `query`. A tool may exist and be
   demoted; `promote { vendor, name }` brings it back into your list at once, no authoring needed.
2. **Is the vendor connected?** `find_tool`'s answer and your `execute__<connection id>` tools name
   the connections in your scope. If the vendor has none, call
   `request_connection { vendor, primaryHost, scheme, displayName?, docsUrl? }` — it answers a
   handoff link (below); the person confirms the connection and enters the secret in the console.
   That page also offers to allow you to build tools against the connection, on by default; left
   on, `acquire` against it starts without a second link, so do not tell the person to expect one.
   A public API that takes no key — Open-Meteo, an open-data endpoint — is scheme `none`: the
   person confirms the connection and enters nothing; never propose a made-up key for one, since
   a vendor may read the key's presence and answer differently.
   A vendor that needs an OAuth consent rather than a key — Gmail, Slack user tokens, Notion — has
   its own note, `connecting-with-oauth.md` beside this file.
   If the person already has the connection but it was made for another of their agents,
   `request_connection` answers `awaiting_scope` with a link instead: the person allows you to use
   the existing connection in the console (no new connection, nothing entered), and the call then
   answers connected. Relay it like any handoff; do not send them to find the Scope page.
   If the vendor *is* connected and a call comes back 401 or 403, or the person says a key was
   rotated, call `request_credential { connectionId }`: a rotated or expired credential is
   `request_credential` on the existing connection, never a new one — a new connection is a new
   row with no scope and no approvals.
3. **`acquire { connectionId, goal, hints? }`, only when nothing fits.** `goal` is what the tool
   must do, in a sentence or two, in the person's terms. `hints` is anything you already know — an
   endpoint, a documentation URL, a field name; a documentation URL is the single most useful hint.

`acquire` waits about half a minute for the job. A job that finishes in time answers `succeeded` or
`failed` with `result`, as `acquire_status` does; otherwise it answers `{ jobId, status, progress }`
and nothing is built yet. A refusal `similar_tools_exist` means the toolbox already holds a tool
that looks like the goal, named with its `inputSchema`: run it with `run_tool` (or `promote` it), and
call `acquire` again with `ignoreExisting: true` only when none of the named tools fits.

## While the job runs: `acquire_status`

Call `acquire_status { jobId }` again whenever the job is unfinished, or when the person asks how it
is going: it waits up to twenty seconds for a progress line newer than the ones you have (`after`,
the count you have seen) or for the end, so each answer carries news. The answer is
`{ status, progress, attempts, result? }`:

- `queued` or `running`: relay the newest progress line in a sentence. Do not start a second
  `acquire` for the same goal while one runs.
- `succeeded`: `result.tool` is the new tool's name, `<vendor>__<name>`. It appears in your tool list
  when the list refreshes (Graft sends `tools/list_changed`; Hermes re-reads the list). Then call it
  for the person's actual request. Some clients snapshot the tool list per conversation; until it
  appears, `run_tool { vendor, name, input }` calls it by name. The acquire result and `find_tool`
  carry the tool's `inputSchema` for `run_tool`, so `input` is read, never guessed; `result.next`
  says the same in one sentence.
- `failed`: say what `result.failure` and `result.message` say, in the person's words, and what you
  will try — a documentation URL as a hint, a different connection. Do not try to reach the vendor
  yourself; there is no route to a vendor except through a Graft tool, and the attempt would only
  look like one.

## Relaying a handoff

Any Graft answer with `url` and an `awaiting_…` word — `awaiting_approval`, `awaiting_connection`,
`awaiting_credential`, `awaiting_scope` — is a **handoff**: the next step is the person's, in the console. Send them
the link exactly as returned, with one line saying what it is for, then wait. When they say it is
done, call the same tool again with the same arguments; Graft finds the answer and continues.

Never put a handoff link into a tool argument, and never ask the person for an API key, a password
or a token in chat, whatever the vendor calls it. The console is where secrets go; you never see one.

## Describing an approval

Graft asks the person before code runs, and asks in two places:

- **Before building** against a connection, once per agent per connection: *"May this agent build
  against <connection>?"* Say what you are about to have built and against which account. The
  person may already have answered this when they confirmed the connection; then no ask comes.
- **Before a tool's first use** that is not a read. A read-only tool never asks. Any other tool asks
  once, and the answer holds — a destructive tool too, and its ask says it is destructive. The person
  can set a tool to ask every time instead, in Graft's console, on the ask or on your agent's page.
  Say what the tool does, in its own description's words, and what this one call will do.

Read the tool's `readOnlyHint` and `destructiveHint` from the tool list to know which sentence
applies.

Hermes shows Graft's ask as its own approval card. Any of its allow buttons is a standing yes to
Graft — Allow Once, Allow Session and Always Allow all record the same allow, because Graft asks once
by rule — and Deny records a no that holds. No button changes whether a tool asks every time; that
switch is in the console, and the ask's text says so. If the card comes back for a tool the person
already allowed, they set that tool to ask every time; say so if they ask. If Hermes answers the card
on its own, with no terminal to show it or because its own approval surface failed, the answer comes
back faster than a person could read the prompt, and Graft reads such a Deny as a dismissal and
answers with a console link instead: relay it like any handoff.

## What not to do

- Do not drive the low-level authoring tools — `read_web_page`, `write_file`, `check_tool`,
  `publish_tool`, `execute__…` — unless the person asked you to author by hand. `acquire` does that
  work, and `read_web_page` reads documentation for it; it is not a way to fetch the person's answer.
- Do not retry `acquire` in a loop, or call it for a goal a tool already covers.
- Do not ask for, store, or repeat a secret. Do not paste a handoff link anywhere but to the person.

## Setup

Graft goes in `~/.hermes/config.yaml` under `mcp_servers`, with the agent token in
`~/.hermes/.env` so the config file holds no secret:

```yaml
mcp_servers:
  graft:
    url: "https://your-graft.example/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

```dotenv
# ~/.hermes/.env
GRAFT_TOKEN=grft_…
```

The token is minted in Graft's console (Agents, then New agent) and shown once. Hermes registers
Graft's tools as `mcp_graft_<tool>` — `mcp_graft_acquire`, `mcp_graft_acquire_status`, and so on.
