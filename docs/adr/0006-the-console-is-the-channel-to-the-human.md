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
