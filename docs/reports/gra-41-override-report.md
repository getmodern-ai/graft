# GRA-41 follow-up report (the esbuild override lives in pnpm-workspace.yaml), PR #24

Saved by the orchestrator from the implementing agent's report, 2026-09-11. Branch `aleks/gra-41-override-in-workspace-yaml`, head `5b4ed50` (one commit: `package.json`, `pnpm-workspace.yaml`, `AGENTS.md`). CI green (Typecheck, Lint & Test 4m23s; CLA), Greptile 5/5 with zero comments at the head. Awaiting sebapoole; not merged.

## Correction to the premise

The `[WARN] The "pnpm" field in package.json is no longer read` line is not pnpm 10.6's. `~/Library/pnpm/pnpm` is a shim for pnpm 11.24.0, which reads the root manifest, warns, then delegates to the 10.6.1 that `packageManager` pins. 10.6.1 still applies `pnpm.overrides` (which is why PR #22's lockfile held); 11 does not; both read `overrides:` in `pnpm-workspace.yaml`, so the workspace file is the one placement both honour. CI installs 10.6.1 via `pnpm/action-setup` from `packageManager`, so CI was never at risk; laptops running the pnpm 11 shim were.

## Measured

- Before: lockfile `overrides:` present; `@esbuild-kit/core-utils@3.3.2` → `esbuild 0.25.12`.
- After: non-frozen `pnpm install` leaves `pnpm-lock.yaml` byte-identical; the warning no longer prints; `--frozen-lockfile` passes. No lockfile change in the PR.
- Negative control: with the override removed from both places, 10.6.1 dropped the lockfile's `overrides:` and re-resolved to `esbuild 0.18.20`, which proves the yaml placement is live.

## Gate (fresh worktree, root)

`check` no fixes; `lint` exit 0 with the two pre-existing `packages/mcp` warnings; `check-types --force` 18/18 `Cached: 0`; `test --force` 18/18 `Cached: 0` with the Postgres integration suite against a throwaway `graft_gra41_test` on `graft-postgres-1` (:5440), since dropped; `db:check-chain`, conflict-marker and decision-record checks clean.

## Leftovers

Worktree removed, branch on the remote, main checkout untouched at `80f3fa6`. The delegated 10.6.1 binary was not located on disk; the shim identification rests on the shim's contents and pnpm's own version report. Not load-bearing.
