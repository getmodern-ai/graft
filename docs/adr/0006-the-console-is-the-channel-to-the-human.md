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
