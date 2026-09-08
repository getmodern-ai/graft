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
- **`main` is protected.** Branch, push, open a PR. Merging needs one approving review, a green
  `Typecheck, Lint & Test` check, and a clean Greptile review; Greptile reviews every PR and edits
  its comment in place, so check the SHA it says it reviewed.
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

## Commands

```bash
pnpm install           # Node 24 and pnpm 10; `packageManager` pins the exact pnpm
pnpm run check         # biome format + lint, writes fixes
pnpm run lint          # biome ci: what CI runs, no writes
pnpm run check-types   # turbo: tsc per package
pnpm run test          # turbo: vitest per package
pnpm run build         # turbo: only packages that declare a build script
pnpm run dev           # turbo: persistent, only packages that declare a dev script
```

`check-types`, `test`, `build` and `dev` are Turbo tasks, so they run whatever a workspace declares
under that script name and nothing for a workspace that declares none. Filter with
`pnpm exec turbo run <task> -F @graft/<name>`. `pnpm run test --force` skips Turbo's cache; read
the summary and confirm `Cached: 0` when a green run is the evidence you are after.

### Adding a package

A workspace is a directory under `packages/` or `apps/`; `pnpm-workspace.yaml` globs both, so no
file is edited to add one. Copy the shape of `packages/core`:

- `package.json` with `"type": "module"`, `exports` pointing at `./src/*.ts` (packages ship source;
  `tsx` and Vite compile it, so there is no build step), and `check-types` and `test` scripts so
  Turbo picks the package up.
- Shared dependency versions come from the `catalog:` in `pnpm-workspace.yaml` (`typescript`,
  `@types/node`, `vitest`); add a line there rather than pinning a second copy of a version.
- `tsconfig.json` extends `@graft/config/tsconfig.base.json` and sets `noEmit`; the base is strict,
  ESM with `moduleResolution: bundler`, `verbatimModuleSyntax` and `noUncheckedIndexedAccess`.
- Tests are Vitest, colocated as `<unit>.test.ts` beside the unit, and services are designed to run
  without a database.

## Conventions carried over from Cando, until this repo has its own

Biome for formatting and linting: two spaces, one hundred columns, double quotes, `noFocusedTests`
at `error` because `biome ci` exits 0 on a warning and an `it.only` would otherwise pass the
required check. `.agents/skills` is excluded from Biome because vendored files answer to their
upstream. `.claude/worktrees` is excluded root-relative on purpose: a `**/` pattern matches the
*containing* path too, so running Biome inside a checkout that sits under a `worktrees/` directory
would exclude the whole checkout and lint nothing (Cando's CAN-147; reproduced here before writing
the pattern). Skills for the vendored engineering workflow will be added now that there is code to
work on.
