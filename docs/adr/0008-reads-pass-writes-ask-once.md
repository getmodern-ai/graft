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
