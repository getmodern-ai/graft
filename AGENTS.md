# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink to this file.

## Before anything else

1. Read `CONTEXT.md`. Every term is used exactly as defined there, in code, comments, copy and
   tickets. When a word has an _Avoid_ list, the list is binding.
2. Read the ADRs under `docs/adr/` that touch the area you are about to work in. They are the
   decisions; this file only points at them.
3. Read `docs/roadmap.md` for what is in scope now and what is deliberately later.

## Working agreement

- **Every pull request has a Linear ticket** in the Graft project, and the PR references it.
- **`main` is protected.** Branch, push, open a PR.
- **A comment states the local consequence and points at the ADR for the argument.** Do not
  restate an ADR in a comment; it will rot. A comment that asserts the state of code elsewhere is
  a claim with a date on it, so name the file or the ticket a reader can check in one step.
- **Consent never moves inside the loop.** Secrets are entered in the console, never through a
  tool argument or a chat. Approvals are the person's. If a change would let Graft's own model
  enter a credential or answer an approval, stop and read ADR 0004 and ADR 0006.
- **The proxy is the only route to a vendor.** A sandbox with any other egress, or a module that
  holds a credential, violates ADR 0010 and ADR 0013 whatever the reason.

## Lineage

The core is copied from Cando's authored-tools framework and Modern's forward proxy (ADR 0011).
When a piece here looks like a piece there, the copy is deliberate and the divergence is the
tenancy model (ADR 0007) and the approval grain (ADR 0008). Do not "sync" from Cando; Cando will
adopt Graft, not the reverse.

## Conventions carried over from Cando, until this repo has its own

Biome for formatting and linting, Vitest colocated with the unit under test, services designed to
run without a database, TypeScript throughout. Skills for the vendored engineering workflow will be
added when there is code to work on.
