---
status: accepted
---

# Reads pass, writes ask once

Approval spends trust, so it is asked for at exactly the moments trust is spent and nowhere else.
Per agent, per tool:

- **Read-only tools pass silently.** This is what lets a working set expand without friction.
- **A tool that is not read-only asks once**, on its first call, and the answer holds.
- **A tool marked destructive asks on every call** until the person relaxes it in the console.
- **`acquire` against a connection asks once per agent per connection**, because that is the
  moment Graft's model starts reading the person's data through dry-run reads.
- **Publishing needs no approval.** A definition is harmless; the first real use is the ask.

Every rule is also emitted as an MCP tool annotation, `readOnlyHint` and `destructiveHint`, so a
harness that gates on annotations decides consistently with Graft. **The annotations on an
authored tool are set by the static checker from the HTTP methods the module actually uses, never
taken from the model's own declaration.**

This is Cando's grant grain, per agent, per connection, per tool, with executor.sh's
annotation-derived defaults in place of Cando's ask-on-first-call-for-everything.

## Considered options

- **Let the harness decide, ask nothing.** Rejected: approval UX varies by harness and vanishes
  behind a messaging surface, and nothing could gate Graft's own dry-run reads.
- **Cando's grain unchanged**, first call of anything asks. Rejected: a person prompted for reads
  turns the prompts off and then also misses the write.
- **Executor.sh's policy model unchanged**, annotations set the default and nobody is asked. Rejected:
  an agent-authored write would pass on the strength of a hint the same agent wrote.

## Consequences and accepted risks

- **An approval is a durable record answerable later** through the console (ADR 0006).
- **A republished tool keeps its approval if it stays read-only**; a republished write tool asks
  again once. Written down here so ADR 0012's repairs inherit a rule rather than invent one.
- **The checker's method inference is the load-bearing part.** A module that hides a `POST`
  behind an SDK call the checker cannot see would be misannotated; ADR 0010's proxy binding is
  what makes the method visible at run time regardless, and the dry run catches it before the
  first real call.

## Amendment 2026-09-15: a destructive tool asks once, like a write

Decided by Aleks (GRA-52). The destructive clause above — *"a destructive tool asks every call until
the person relaxes it in the console"* — is reversed. **A destructive tool asks once per agent, and
the answer holds, exactly as a write's does.** What the destructive annotation still changes is what
the ask *says*: the message and the console card name the tool destructive and say plainly that it
can delete or overwrite data.

**Asking on every call becomes the person's opt-in, per tool and per agent, both ways.** Every tool
that asks — write or destructive — carries an `askEveryCall` setting, off by default. The person
turns it on from the ask itself (the console card's switch, or the `askEveryCall` field of the
elicitation form) or from the agent's page, and turns it off the same ways. While it is on, the
standing row says `allow` and the rule still says *ask*, so each call's yes is that call's; off, the
row holds. The one-way "relax" is gone, and so is its column: `per_call_relaxed` was dropped rather
than inverted, because a destructive allow recorded under the old rule now holds, with the opt-in
off — the person can turn it on. No migration rewrote an answer.

**Why.** Every established harness and chat product asks once and lets the person opt into stricter
behaviour per tool; Graft was more cautious than its peers. The relax switch lived only in the
console, which Hermes's approval buttons cannot reach, so for the harness the launch targets the
rule read as friction without the promised escape hatch — the card came back on every call whatever
button was pressed (ADR 0006, on GRA-42).

**Reasons weighed and set aside.** *The destructive label is model-made*: it is derived by the check
from the HTTP methods the module uses, not claimed by the model, and it still names the risk in the
ask; a person who does not trust a given tool sets it to ask every time. *Agents run unattended for
days*: a standing allow on a destructive tool is a standing allow on a write today, and both stay per
tool, per agent, and withdrawable from the agent's page at any moment; a `deny` holds just as it
did. Both concerns are met by keeping per-call asking available as the opt-in rather than the
default.

**Unchanged.** Reads never ask. `acquire`'s build approval asks once per agent per connection. A
decline holds; a dismissal records nothing. Revoking a connection deletes every approval for its
vendor's tools. In Hermes, Allow Once, Allow Session and Always Allow all record a standing allow,
which is what the buttons say; Deny records a standing deny; the setting is the console's.
