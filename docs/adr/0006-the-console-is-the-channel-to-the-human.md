---
status: accepted
---

# The console is the channel to the human

The person is not in a chat with Graft, and often not at a keyboard when their agent runs. Every
step only a human can do goes through **Graft's web console, reached by a handoff URL**: a
meta-tool returns a URL pre-filled with everything that is not secret, the agent relays it, the
person opens it to type a client secret, complete an OAuth consent, or answer a pending approval,
and the tool waits or polls. This works for every harness and every messaging surface a harness
sits behind.

**MCP elicitation is layered on top, for approvals only**, where the client supports it. Hermes
raises elicitations; OpenClaw's support is unconfirmed. Elicitation is never used for secrets: the
MCP specification's security section says servers must not request sensitive information such as
passwords or API keys through it. A CLI exists as a thin wrapper that opens the console URL and
catches an OAuth callback on localhost for people at a terminal.

## Considered options

- **Secrets through the agent's chat.** Rejected, as Cando and executor.sh both reject it: the
  secret then sits in model context and in transcripts.
- **Elicitation for everything.** Rejected by the specification for secrets and by OpenClaw's
  uncertain support for anything.
- **CLI only.** Rejected: absent for the person who reaches their agent over Telegram.

## Consequences and accepted risks

- **Graft has a web console from the first release**, and every person has an account on it, in
  the self-hosted form too, where the image bootstraps a single admin the way executor.sh's does.
  This is what pulled the tenancy decision (ADR 0007) forward.
- **An approval can be answered later.** A pending action is a durable record with a URL, so the
  agent's turn can end and the person can answer from the console hours after. Cando's cards
  behave this way, and a record held in one process's memory dies with the process, so the
  record must be durable.
- **The handoff URL is a phishing-shaped artefact.** It is signed, short-lived, bound to the
  agent that requested it, and displays the requesting agent and the vendor host on the page.
- **An elicitation's `accept` is the yes, whatever the client put in the form.** Hermes 0.21.1
  renders Graft's form-mode approval as its own card — Allow Once, Allow Session, Always Allow,
  Deny — and answers every allow button with `accept` and empty content, so a schema that required
  `allow` sent every button press to the handoff (GRA-42). `allow` is therefore optional and absent
  reads as true; `accept` with `allow: false` remains a form client's no in place. Graft sees one
  `accept` for all three allow buttons and does not guess which was pressed: every one records a
  standing allow, on a destructive tool as on a write (ADR 0008, amendment of 2026-09-15), even when
  the button said once, and none touches the tool's ask-every-call setting, which is the console's.
  Hermes keeps no memory on its elicitation path (`request_elicitation_consent` in its
  `tools/approval_prompt.py`: Deny is `decline`, no answer is `cancel`, and session and always are
  not persisted), so its card comes back on every ask Graft makes. The harness's buttons name the
  harness's grain; Graft's record keeps Graft's.

## Amendment 2026-09-16: a cancelled elicitation falls through to the handoff

Decided by Aleks (GRA-55). **A client can advertise forms it never shows.** Claude Code in
non-interactive mode (`claude -p`) declares `elicitation` in `initialize` and answers every form
`cancel` without rendering it (GRA-54's live check), and the same shape is plausible for any client
whose form support depends on the mode it is running in. Under the rule as first applied — a `cancel`
recorded nothing and the ask repeated — Graft asked such a client again on every call, and the person
never received a link, so nothing could be approved from that client at all.

**The rule.** An elicitation answered `cancel` is treated as the channel being unavailable for that
ask: nothing is recorded, and the ask goes to the handoff exactly as it does for a client that
declared no elicitation — the tool result carries `awaiting_approval` and the console URL, and a
durable pending action stands for the person to answer. `decline` keeps its meaning: the person said
no, recorded as a standing deny on a tool ask and a plain refusal on a build ask. `accept` is
unchanged. The tool ask and the build ask (`acquire`, the execute tool) follow one rule because they
share the channel (`packages/mcp/src/approval.ts`).

**Per ask, not per session.** Each ask tries the form first when the client advertises one and falls
through on `cancel`; nothing remembers the cancel. Remembering it for the session would save one
round trip on a client that cancels every form, and that round trip is milliseconds — the cancel
comes back at once — while a person who closed one form in a client that does render them would
then see links for the rest of the session instead of forms. The doomed round trip is also rarer
than it looks: the console's answer writes the approval the ask was for, so the call after a console
answer passes at the rule without asking anyone, and only the next *distinct* ask offers a form
again. A per-session memory stays available if a client turns out to cancel slowly; it would reset
with the session and be recorded here.

**A waiting console answer is taken before any form is offered.** When the earlier ask went to the
handoff and the person has since answered it in the console, the next call takes that answer and
offers no form — it is the person's answer to this very ask. Offering the form first would let a
form answer overtake it, and a per-call yes the console gave for one call would then wait, unspent,
to be applied to some later call it was never given for (raised by Greptile on the pull request).
An ask still open — answered by nobody yet — is offered in place first, and the handoff reuses its
row when the form carries no answer.

**Where else this shows.** Hermes's buttons never send `cancel` (GRA-42's mapping above: every allow
is `accept`, Deny is `decline`), so the buttons are unaffected. Hermes's no-answer path, which the
GRA-42 bullet records as `cancel`, now yields a link rather than the card again — a person who let a
card lapse answers from the console, which is what "an approval can be answered later" above already
promises. ADR 0008's "a dismissal records nothing" stays true; what changes is the channel the ask
falls back to.

## Amendment 2026-09-18: a decline faster than a person could read the prompt is a dismissal

Decided by Aleks (GRA-43). **A client can also answer a form it never showed with `decline`.** Hermes
0.21.1 does so in two situations that are not a person's choice: when its own approval surface fails
inside (a gateway without a `notify_cb`), and when it runs non-interactively (`hermes chat --oneshot`
with no terminal) and takes its default, `[D]eny`. Observed on GRA-35's Docker leg on 2026-09-18 at
04:30 UTC: Graft's build ask was declined twice in a row within a second of being asked, `acquire`
was refused `approval_declined` with no handoff link, and the agent had no way forward. On a write
tool's first-use ask the same reflex would have recorded a standing `deny` nobody chose (ADR 0008: a
decline holds).

**The rule.** An elicitation answered `decline` faster than a person could read the prompt is read as
a dismissal: nothing is recorded, and the ask goes to the handoff exactly as a `cancel` does under the
amendment of 2026-09-16, with one sentence added to the handoff's answer saying the client answered
the prompt on its own and the person can answer in the console. **The threshold is 1.5 seconds** on
the round trip, from the ask leaving to the answer arriving, held as the exported constant
`AUTOMATIC_ANSWER_MS` in `packages/mcp/src/approval.ts` and measured on the clock that module is
already given (`deps.pendingAction.now()`), so a test moves the clock rather than sleeping. A
`decline` at or past the threshold is the person's and keeps its meaning: a standing deny on a tool
ask, a plain refusal on a build ask. An `accept` is taken at any speed. Each elicitation's outcome is
logged with the round trip in milliseconds and an `automatic` flag, so the threshold can be read
against what clients actually do.

**Why a threshold and not a client check.** Nothing on the wire says whether a person saw the form:
Hermes sends the same `decline` from its Deny button and from its default, and `initialize` names the
client, not the mode it is running in. What does differ is time. A person reads a card that names an
agent, a vendor and a tool before answering it; both of Hermes's own answers arrived within a second
of the ask, most of that transport. One constant, exported, so a client found to answer for the
person more slowly moves it in one place.

**Accepted risk.** A person who presses Deny within 1.5 seconds of the card appearing is not refused:
they receive a console link instead, and their no is still theirs to give there. The reverse error, a
machine's no held against the person as a standing deny, is what this amendment exists to prevent,
and of the two it is the costlier and the one observed. Accepts are deliberately outside the rule: a
yes a client gives for the person is the harness's failure to guard its own surface, and reading
fast accepts as dismissals would send every quick button press to the handoff, the outcome GRA-42
removed.

**Unchanged.** `cancel` falls through as the amendment of 2026-09-16 says; the fall-through is per
ask; a waiting console answer is taken before any form is offered. ADR 0008's "a decline holds" is
about the person's decline, and this amendment narrows how one is recognised, not what it does.

## Amendment 2026-09-18: a chat product's card is a channel of elicitation's standing

Decided by Aleks (GRA-84, after GRA-83's spike and the cross-host research on the ticket). Claude.ai
and ChatGPT render an MCP App — a page the server names on a tool and serves as a resource — inline
where the tool's result lands, and on Claude.ai they do so without declaring the extension in
`initialize`. Graft's build approval is a yes or no with context, which is the shape a card shows
best, and the connection confirmation for a public API is a set of non-secret facts and a button.
Until now both reached a person in a chat product only as a handoff link relayed by the model.

**The rule.** The **ask card** (`ui://graft/ask`, `packages/ask-card`) is a channel to the person of
the same standing as elicitation: layered on top of the handoff, per ask, never remembered, and only
where the host renders it. Its answer arrives as the person's click, relayed by the host as a
`tools/call` of `answer_ask` that the host hides from the model (`_meta.ui.visibility: ["app"]`).
Graft admits that call only from an **agent a chat product holds over OAuth** (ADR 0018:
`connected_via_client_id` set) **whose client's hiding of app-only tools is established** — every
redirect URI the client registered is on a card host (`GRAFT_CARD_HOSTS`, by default `claude.ai`
and `chatgpt.com`, the two products' callbacks), or the session's client declared the MCP Apps
extension in `initialize`, which binds it to the specification's host rules; ADR 0018 registers
any client dynamically, so the OAuth grant alone would admit a naive client that lists the tool to
its model — only for **that agent's own ask**, only while it is **open and in time**, and only for
**three asks**: the build approval; the connection confirmation for a proposal whose scheme takes
no credential and whose provider connects through the form; and, since 2026-09-19 (GRA-104, the
paragraph below), the scope ask. The record
is the console's record — the same `build_approval` row, the same connection row in the same
agent's scope, the same answer on the action, through the same functions
(`packages/mcp/src/ask-answer.ts`) — with `via: "card"` on the answer to say which door it came
through. The tool's result is GRA-55's shape unchanged: `awaiting_*`, the URL and the message stay
in the text the model reads, and the card's data rides beside them in `structuredContent` alone, so
a host that renders nothing shows exactly what it showed before. An awaiting result is **not an MCP
error** (`isError: false`; added 2026-09-19, GRA-112, after the live ChatGPT test mounted the frame
blank): the person's step is the tool's answer, and a host renders no view for an error result —
ChatGPT unmounts the frame and Claude never mounts it (ext-apps issue 694) — so the card could not
render for the very results it exists for; refusals and failures stay errors.

**The handoff URL is the floor.** Every ask still returns it, the card shows it as *Open in the
console* wherever it may not answer, and a card that never mounts (Claude.ai's open rendering
defect, anthropics/claude-ai-mcp#61) costs the person nothing they had.

**What keeps the session.** A credential re-entry and every scheme with a secret are not the card's
to answer: the card shows the proposal and the one console button. Secrets are entered in the
console, never through a tool argument or a chat (ADR 0004), and this amendment moves none of that;
a person's identity is not available inside the card — only the agent's session is (GRA-83). As
first written this paragraph kept a write's first-use approval and a link provider's ask on the
console too; the paragraph of 2026-09-19 below moves both into the card, and narrows what stays to
the secret alone.

**Why a hidden tool and not a route.** The ticket weighed a token-bound post to Graft's origin, with
the handoff token as the whole authority, against an app-only tool. The tool was chosen because it
adds no route, no CORS surface and no second use of the handoff token, and because the card's call
then reaches Graft under the agent's OAuth session and the same door every call takes
(`requireAgent`). Its cost is the residual risk recorded here: nothing on the wire proves a
`tools/call` came from the card rather than the model — no host documents a marker, and a result's
`_meta` is model-visible on Claude — so the guard is the host's hiding plus Graft's own gate: the
OAuth requirement keeps Hermes's and OpenClaw's models, which see every tool their server lists,
from ever answering their own asks, and the card-host or extension signal keeps an unknown OAuth
client's model out too, since a client can register itself but cannot register a redirect on
`claude.ai` or forge the other side of its own `initialize`. The live check on both hosts has to
confirm that neither lists `answer_ask` to its model; a host that does is a host the card is
withdrawn from, by taking it off the list.

**The third card: a connection the person holds but this agent was not given** (added 2026-09-19,
GRA-104; decided by Aleks after his Claude.ai test of 2026-09-19). A proposal that matches a live,
usable connection of the person's made for another of their agents used to be the one person step
with no handoff: `request_connection` refused `connection_exists` with `inScope: false` and a
sentence telling the person to find the agent's page and its Scope picker, so the model relayed a
warning-shaped tool call and no link, and the card had nothing to render. It is now an **ask** of its
own kind, `scope` — a pending action stamped with the connection, a signed handoff URL, the same wait
and poll as the connection ask, and `awaiting_scope` in GRA-55's shape — whose page says "<agent>
asks to use <connection> (<vendor>, via <provider>)" with Allow, Decline and GRA-75's build choice on
by default. Allow is the scope change the agent page's picker makes and, ticked, the build approval,
in one transaction on the generic answer route (`{ allow: true, approveBuild? }`); the next call
answers `connected` with the execute tool named. The card renders it as answerable and `answer_ask`
admits `{ allow, approveBuild? }` for it under the same gate, because it is a yes or no on a
connection the person already made, with nothing to enter — the same standing as the build approval.
A revoked row and a live row in scope keep GRA-76's answers; a live row outside the scope whose
credential is missing keeps its refusal, since allowing it would give the agent nothing to call
through. Since ADR 0007's amendment of 2026-09-19 (GRA-105) a new agent reaches every connection
of the person's, so this ask is reached only for an agent the person limited to a list; the ask
itself does not move.

**The fourth card, and the two asks the card starts without answering** (added 2026-09-19,
GRA-116, GRA-117, GRA-118; decided by Aleks after the live card tests of 2026-09-19: every person
step except the one-time OAuth consent should stay in the chat). **A write's first-use approval is
the fourth card.** The `tool` ask (ADR 0008) renders "Allow <agent> to run <vendor__name>?" with
the tool's description marked as the model's words, its read-only and destructive hints, the
connection and the agent, Allow and Deny; `answer_ask { allow }` records it through
`recordApprovalAnswer` exactly as the console's answer route does — an allow that holds, a deny
that holds — under the same gate. The ask-every-call setting is not the card's: it stays on the
agent's page, the card says when it is on, and a yes on such a tool is for the one waiting call, as
the console's is. **A link provider's connection starts from the card.** The card mints the
provider's link itself through a second app-only tool, `start_link { pendingActionId,
approveBuild }` → `{ url, expiresAt, provider }`, the same `mintProviderLink` the console's button
calls (`packages/mcp/src/provider-link.ts`), and opens it with `ui/open-link`; the return leg is the
server's route unchanged — it makes the row and answers the ask — so the card answers nothing for
it and may only decline it. **The console remains where a secret is typed, opened from the card
as a popup that closes itself.** For a scheme with a credential and a credential re-entry the
card's button reads *Enter the secret in Graft* and opens the handoff URL with `from=card`; the
pending page closes itself 1.5 s after a successful submit and tells its opener at its own origin
(`graft:ask`), and the link's return page does the same when its link carried the flag. The card
cannot hear either page — it is a frame on the host's origin — so it polls a third app-only read,
`ask_status { pendingActionId }` → `{ state: open | answered | declined | expired, sentence }`,
every three seconds until the ask is settled, and shows the sentence; the two new tools are gated
as `answer_ask` is (`packages/mcp/src/tools/card-gate.ts`), and `ask_status` records nothing. A
host that refuses `ui/open-link` leaves the card with the console button it always had.

**The awaiting answer says where the ask is** (added 2026-09-20, GRA-120; decided by Aleks after
the live ChatGPT and Claude.ai tests of 2026-09-19 and 2026-09-20). With the card rendered, the
model still pasted the console link beneath it and said "once you approve it, I can call X again",
because `SERVER_INSTRUCTIONS` said "send them the link exactly as returned" of every awaiting
answer and the answer's `message` said the same; under a card the link is a second door to the
same ask and the sentence is noise. The server already knows, per session, whether the client
renders the card and hides its tools — the gate's client half above — so the same verdict now
shapes the answer: for such a session the awaiting `message` takes its **card form** — the ask is
shown as a card in this conversation and the person answers it from there; the url opens the same
ask in the console for a person who cannot see the card — and `cardShown: true` rides beside
`url`, in the text the model reads and in `structuredContent` alike (`packages/mcp/src/card-client.ts`,
`handoff-message.ts`). The instructions gain one clause, that a `cardShown` answer is answered on
the card and the url is relayed only to a person who says they cannot see it; the descriptions
gain nothing (GRA-111). **The handoff URL stays the floor**: it is on every answer in both forms,
unchanged, and a card that never mounts (anthropics/claude-ai-mcp#61) costs the person one
sentence — "I cannot see a card" — before the model relays it, which is the accepted risk of
reading the client's word for its rendering. A static-token agent's answer, an unvouched OAuth
client's and every refusal are byte for byte what they were; Hermes renders no card, so its skill
does not name `cardShown` and `session.test.ts` says why.

**A card that fails to mount once after a deploy is the host's** (noted 2026-09-20, GRA-124). Twice
on Claude.ai, a few minutes after a deploy of the hosted form, the first card-bearing result in an
open chat drew Claude's "Unable to reach Graft" banner where the card goes, and the repeated call
rendered it. The server's request log shows the shape: Claude's frame made no request at all for
that first result; on the next it sent two requests with no session id and not an `initialize`,
was answered 400 by the SDK's transport, then initialised and read the resource. ChatGPT's client
over the same deploy got 404 for its old session ids and re-initialised silently, the spec's path.
Graft's sessions are in-memory transports and a deploy ends them; the answers are the spec's
(`packages/mcp/src/http.ts`); nothing here changes, and the fallback sentence above is what the
person gets. *Superseded 2026-09-20 (GRA-129):* the banner came back on every open Claude chat after
every deploy, so the transport now re-opens a session it no longer holds for a chat product's
client — ADR 0018 as amended 2026-09-20 has the rule; the fallback sentence stays for the rest.

**Unchanged.** ADR 0004 and ADR 0008. Elicitation keeps its place before the handoff for the clients
that show a form. `acquire` still asks once per agent per connection; the connection confirmation
still offers the build approval on by default (ADR 0008 as amended 2026-09-18, GRA-75), on the card as
on the page. Hermes renders no apps; its skill names `awaiting_scope` beside the other handoffs and
is otherwise untouched.

## Amendment 2026-09-21: the handoff link opens a focused page, not the console

The console is still the channel to the human, and a handoff URL is still `/pending/<id>?t=<token>`
on every answer, checked by the server against the row and by the guard against the session. What
changes is the page the link opens (GRA-144). It was the console: the pending action inside the
shell, sidebar and nav around one card. A person driving Graft from a terminal — Hermes for a
connection or a secret, OpenClaw for every ask, since it elicits nothing — was in a terminal a
moment ago, and the whole console is a heavy page for one button. Aleks, 2026-09-21: "we don't have
to go down the path of cards for them, but small popups (instead of full console) will suffice."

**The rule.** The pending-action detail route sits under the guard alone, outside the shell: the
mark, the one ask's card, a link to the console, nothing else. Once answered, a link visit closes
itself — the card popup tells its opener first, as the 2026-09-18 amendment's contract says — and a
tab the browser will not close shows an answered state instead. A visit without a token goes back
to the list. **Pending actions in the console is unchanged**: it renders every open ask inline with
the chrome and remains the place to browse and answer later. The URL, the card contract
(`card.rules.ts`), the handoff builder and the server routes do not change, so nothing an agent, a
skill or a card relays moves.

**Unchanged.** ADR 0004: the secret is still typed on Graft's own page and nowhere else; the page
lost its chrome, not its guard or its token check. Elicitation keeps its place before the handoff
for the clients that show a form; this is the surface for the steps that must be a link.


## Amendment 2026-09-21: the card gate admits a client by its callback host alone

Decided by Aleks (GRA-150). The amendment of 2026-09-18 admitted a chat product's `answer_ask`
call on either of two signals: every redirect URI the client registered is on a card host
(`GRAFT_CARD_HOSTS`), or the session's client declared the MCP Apps extension
(`io.modelcontextprotocol/ui`) in `initialize`. **The second signal is withdrawn.**

**Why it was wrong.** A client writes its own `initialize`. Nothing in the MCP Apps specification,
in `@modelcontextprotocol/ext-apps` 1.7.5 or in either host's published guidance lets a server
check the declaration against anything: ext-apps issue 746 says a server cannot enforce
`visibility` and issue 738 says a future marker on a call from a view would not be an
authorization primitive either. The sentence in the amendment of 2026-09-18, "a client can
register itself but cannot register a redirect on `claude.ai` or forge the other side of its own
`initialize`", is withdrawn in its second half. Because both products' callbacks are on the
default list, the extension signal admitted no product and only clients nobody had vouched for:
any dynamically registered client that wrote the string into its handshake and listed `answer_ask`
to its model could have its model settle the build approval, a tool's first-use approval
(destructive included), the keyless connection confirmation and the scope ask, and mint a
provider's link through `start_link`. That is the loop answering for the person, which ADR 0004
exists to prevent.

**What still holds.** The callback host, because it is not the client's to claim: a client may
register a redirect URI on `claude.ai`, but it can only finish Graft's OAuth flow if it controls
what answers there, so a registration on a card host is a statement the product itself made. And
the OAuth requirement, which is the first check and unchanged: a static-token agent's harness
(Hermes, OpenClaw) renders no app, so a call from one can only be its model's, and no declaration
moves it. Everything else in the amendments of 2026-09-18, 2026-09-19 and 2026-09-20 stands: the
four cards and what each may answer, the handoff URL as the floor, the console for the secret, and
`cardShown` on the awaiting answer, which is the same verdict and therefore narrows with it.

**The consequence.** A chat product whose callback is not on the list reads the console form and
answers in the console, which is what every agent had before the card and costs the person a
click. A self-hoster whose own chat product renders apps adds its callback host to
`GRAFT_CARD_HOSTS`, which is now the whole rule and says so. The declaration itself is still read,
as an observation on each tool call's wide event, so an operator can see which clients make it.

**The live check owed.** This ADR already says a host that lists `answer_ask` to its model is a
host the card is withdrawn from, by taking it off the list. That check was recorded for ChatGPT
(GRA-112) and never for Claude.ai. It is to be done on both and recorded on GRA-150: with Graft
connected, ask the model to list every tool the Graft connector gives it, and confirm `answer_ask`,
`start_link` and `ask_status` are absent. Claude Desktop, Claude mobile and Cowork are unknown to
this repository, since none of their registered callbacks is recorded here; a connect from each and
a read of the `mcp_client` row's redirect URIs would say whether they are on `claude.ai` and so
already admitted.

## Amendment 2026-09-22: a keyless proposal for a connection the person holds widens it

GRA-167, from the clean Hermes run of 2026-09-22. "Convert 100 USD to EUR" became a keyless
connection to Frankfurter at the host its documentation names; the person confirmed it; every read
was answered with a redirect to a sibling host the row did not list, so the job stopped and the
agent re-proposed the vendor at the sibling. The person confirmed a second time and the console held
two live rows for one public API, the tool bound to the second.

**The rule.** A `request_connection` whose scheme is `none`, for a vendor the person already holds
as a live, usable keyring row on `none` in this agent's scope, at hosts that row does not all reach,
is a **widening**: a `connection` ask about *that row* — its primary host and name, its hosts grown
to the union, `widens` on the payload naming the row and the added hosts, the row stamped on the
action so a revoke closes it. The yes grows the row's host set and makes nothing new
(`widenKeylessConnectionHosts`); the agent's next call answers `connected` naming the row it already
had. The card and the console's card draw the added hosts and no form, and the ask card answers it
in place as it answers the keyless confirmation, since it is one.

**What does not move.** The person still confirms: the host set is what they consented to and what
the proxy relays to and nothing else, so a host is never added without them. A keyed row is not
widened — its credential would go to a host it never went to, and no ask offers that yet — and a
row outside this agent's scope is not, since the scope ask is about a row as it stands; both keep
GRA-76's and GRA-104's answers. The person pays one confirmation for the correction instead of a
second connection.

