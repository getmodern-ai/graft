# GRA-44 report (the console takes Cando's tokens, type stacks, icons and theme, with the guards), PR #25

Saved by the orchestrator from the implementing agent's report, 2026-09-11. Merged into main by the orchestrator after sebapoole's approval, green CI and Greptile 5/5.

## Report for the orchestrator — GRA-44

**PR #25** — https://github.com/getmodern-ai/graft/pull/25 — head `495ffdd15c2ecb3628cc47c8ac5d5354c6eb95f3`, branch `aleks/gra-44-the-console-takes-candos-tokens-type-stacks-icons-and-theme`, four commits (console change → guards → ADR/docs → Greptile fix). Reviewer `sebapoole` requested and **approved**. GRA-44 is **In Review** in Linear with the PR linked. Worktree `gra-44` left in place, clean.

**CI / review state.** `Typecheck, Lint & Test` green on both heads (5m36s on the final one), with the two new steps `Check for hardcoded colours and mode-orphaned tokens` and `Check design-token utilities against the built CSS` both `success`. CLA pass. **Greptile: 5/5 on `495ffdd`**, "no actionable new failures or outstanding previous findings". Its first pass (4/5) raised two things, both addressed with a fix commit and a reply: (P1) the raw sonner `Toaster` drew light toasts in dark mode → replaced with Cando's theme-aware `sonner.tsx` wrapper; (P2) guards scanned only `.ts/.tsx` → both now scan `apps/web/index.html` (HTML comments blanked by a tested `blankHtmlComments`), its two hexes are the second `COLOUR_EXCEPTIONS` entry; `index.css` beyond `@theme` deliberately stays out of Rule A (Greptile agreed: "That distinction is sound").

**Gate (final head).** `check` no fixes left (2 pre-existing warnings in `packages/mcp`); `lint` clean; `check-types` green; `test --force` 18/18, `Cached: 0`, server integration suite against a throwaway DB on the compose Postgres (created/dropped), console suite 70 tests (50 are the guards'); `check-colours` 84 sources, 2 exceptions both matched, 90 mode pairs, no findings; `check-tokens` 33 utilities / 94 tokens all resolve; `db:check-chain` continuous; CI's conflict-marker and ADR checks pass locally (newest ADR 0017). Managed token block verified **byte-identical** to Cando's `origin/main` 78c94829.

**Deviations from Cando, and why**
- Left out of `index.css` (named in its header): `--agent-*` tints (no agent faces), `--chat-input-shadow`/`--shadow-chat-input` (no chat), both `@utility` sheens (`button-sheen` arrives with Cando's `button.tsx` in GRA-45; `agent-disc-sheen` has no consumer), the six `@font-face` (GRA-49 licence), monorepo `@source` lines.
- Managed-block *comment* rewritten to name the copy source and inherited quirks (`#fd6a41`/`#fd5a2a` split, dark `--destructive` pair); *values* untouched.
- Icon set is 39 glyphs, not 67; three aren't in Cando's list: `smart_toy` (Bot), `inbox`, `key`. Mapping choices: Plug→`power`, ShieldAlert→`dangerous`, TriangleAlert→`warning`, Globe→`language`, Compass→`explore`. `UNFILLED` keeps only `view_sidebar`.
- Exceptions: two entries for one fact (theme-provider, index.html) vs Cando's four (theirs exempt Cando artwork).
- Guards additionally scan `index.html`, skip `src/tokens/` + tests in the utilities check, admit `scrim-` in the prefix list; the CI `check-tokens` step rebuilds if `dist/assets` is absent.
- `bg-black/10` → `bg-scrim` directly (token exists now) rather than a temporary exception.
- `sonner.tsx` copied ahead of GRA-45; omits Cando's inert `cn-toast` class.
- Catalog: `shadcn ^4.19.0` resolves to 4.21.0; `@material-symbols/svg-400` to 0.47.2; `next-themes ^0.4.6`. `lucide-react` removed from package and catalog (nothing else used it).

**Left for GRA-45 / later.** Primitives unchanged (`rounded-none`, `text-xs`, `ring-1`; `shadow-button`/`-hover` declared so the classes exist when `button.tsx` lands); `button-sheen` utility; `bg-scrim` on AlertDialog/Sheet/Drawer once they exist; no visible theme toggle (shell ticket); GRA-49 `@font-face` + `.woff2`. GRA-45's list can drop `sonner.tsx`.

**Screenshots** (8) under graft-cloud `docs/screens/gra-44/`: `login-{1440x1024,390x844}-{light,dark}.png`, `agents-{1440x1024,390x844}-{light,dark}.png`. Captured on head `54de524` before the Toaster fix, which changes neither screen (no toast is shown). Verified alongside: `.dark` on `<html>`, `color-scheme: dark`, both `theme-color` metas rewritten to `#0f0c0a`, body bg `oklch(0.157 0.0066 55.82)`, font stack Cando's, zero font requests, zero 4xx.

**For the orchestrator to decide**
1. Merge — approved, green, Greptile clean; I did not merge.
2. Confirm the four glyph judgement calls (`smart_toy`, `power`, `dangerous`, `key`) or name replacements; each is one `NAMES` entry + regenerate.
3. The Docker server on :3100 trusts only its own origin, so a console dev server on :3001 gets `INVALID_ORIGIN` on sign-in; I worked around it via host-scoped cookies. If the dev-against-Docker path is meant to work, the compose `.env` wants `GRAFT_CORS_ORIGIN=http://localhost:3001` — out of this ticket's scope.
4. GRA-44's acceptance-criteria checkboxes in the Linear description are untouched; tick or close on merge.