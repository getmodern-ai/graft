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
  agent's turn can end and the person can answer from the console hours after. Cando's cards and
  executor.sh's resume URL both behave this way; executor.sh's own bug history shows why the
  record must be durable rather than held in one process's memory.
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
`connected_via_client_id` set), only for **that agent's own ask**, only while it is **open and in
time**, and only for **two asks**: the build approval, and the connection confirmation for a
proposal whose scheme takes no credential and whose provider connects through the form. The record
is the console's record — the same `build_approval` row, the same connection row in the same
agent's scope, the same answer on the action, through the same functions
(`packages/mcp/src/ask-answer.ts`) — with `via: "card"` on the answer to say which door it came
through. The tool's result is GRA-55's shape unchanged: `awaiting_*`, the URL and the message stay
in the text the model reads, and the card's data rides beside them in `structuredContent` alone, so
a host that renders nothing shows exactly what it showed before.

**The handoff URL is the floor.** Every ask still returns it, the card shows it as *Open in the
console* wherever it may not answer, and a card that never mounts (Claude.ai's open rendering
defect, anthropics/claude-ai-mcp#61) costs the person nothing they had.

**What keeps the session.** A write's first-use approval, a credential re-entry, a link provider's
ask and every scheme with a secret are not the card's to answer: the card shows the proposal and the
one console button. Secrets are entered in the console, never through a tool argument or a chat
(ADR 0004), and this amendment moves none of that; a person's identity is not available inside the
card — only the agent's session is (GRA-83) — so a write's ask, which the person may set to ask
every time, keeps the page where that setting lives.

**Why a hidden tool and not a route.** The ticket weighed a token-bound post to Graft's origin, with
the handoff token as the whole authority, against an app-only tool. The tool was chosen because it
adds no route, no CORS surface and no second use of the handoff token, and because the card's call
then reaches Graft under the agent's OAuth session and the same door every call takes
(`requireAgent`). Its cost is the residual risk recorded here: nothing on the wire proves a
`tools/call` came from the card rather than the model — no host documents a marker, and a result's
`_meta` is model-visible on Claude — so the guard is the host's hiding plus Graft's own gate, and the
OAuth-only gate is what keeps Hermes's and OpenClaw's models, which see every tool their server
lists, from ever answering their own asks. The live check on both hosts has to confirm that neither
lists `answer_ask` to its model; a host that does is a host the card is withdrawn from.

**Unchanged.** ADR 0004 and ADR 0008. Elicitation keeps its place before the handoff for the clients
that show a form. `acquire` still asks once per agent per connection; the connection confirmation
still offers the build approval on by default (ADR 0008 as amended 2026-09-18, GRA-75), on the card as
on the page. Hermes renders no apps, and its skill is untouched.
