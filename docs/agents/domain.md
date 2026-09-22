# Domain docs

How the engineering skills should consume this repository's domain documentation when exploring
the codebase.

This repository is **single-context**: one glossary and one decision log, at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root: the glossary.
- **`docs/adr/`**: read the ADRs that touch the area you are about to work in.
- **`docs/roadmap.md`**: what is in scope now and what is deliberately later.
- **The pull request body** of any ticket you build on, indexed by `docs/reports/README.md`. It is
  the build record; an ADR records a decision and Linear holds the ticket.

All exist. There is no `CONTEXT-MAP.md`, and adding one is what would signal a move to
multi-context.

If a file named here is ever missing, **proceed silently**. Don't flag its absence and don't
suggest creating it upfront. `/domain-modeling`, reached via `/grill-with-docs` and
`/improve-codebase-architecture`, creates these lazily, when a term or a decision actually gets
resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-graft-is-the-loop-not-the-catalog.md
│   └── …
├── docs/roadmap.md
├── docs/reports/README.md
└── packages/, apps/
```

## Why single-context, despite the monorepo

This is a pnpm workspace with two apps and some twenty packages, which usually hints at multiple
bounded contexts. It isn't one here. The packages are seams of one product, and *agent*,
*connection*, *person*, *tool* and *working set* mean the same thing in every one of them; the
hosted form's private package (ADR 0002) shares the vocabulary rather than owning another. A word
that meant something different in `packages/proxy` than it did in `packages/mcp` would be the
signal to split, and there isn't one.

If that changes, the move is a root `CONTEXT-MAP.md` pointing at per-package `CONTEXT.md` files,
with `docs/adr/` at the root kept for system-wide decisions.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test
name) use the term as `CONTEXT.md` defines it, and don't drift to a synonym it lists under
_Avoid_. Those lists are binding rather than decorative, and `AGENTS.md` says so in its first
paragraph. One that bites in this directory: *agent* is Graft's word for a harness's record, and
these files use it for the coding agent reading them; keep the two apart in anything you write
outside `docs/agents/`.

If the concept you need isn't in the glossary, that's a signal: either you're inventing language
the project doesn't use (reconsider), or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0008 (reads pass, writes ask once), but worth reopening because…_

An ADR here is a decision with its reasoning attached, amended in place with a dated line when it
moves (ADR 0006, 0007, 0008 and 0018 each carry several), not a rule to be obeyed past the point
it stops making sense. Moving one is a conversation, not a silent edit, and the repository and
its history are public: the reasoning that belongs in an ADR is the engineering reasoning, and a
private reason goes in the Linear ticket.
