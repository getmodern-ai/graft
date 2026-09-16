# GRA-49 report (GT Standard L and GT Standard Mono ship with the console), PR #27

Saved by the orchestrator from the implementing agent's report, 2026-09-11.

## GRA-49 report

**PR #27** — https://github.com/getmodern-ai/graft/pull/27 — `feat(web): GT Standard L and GT Standard Mono ship with the console (GRA-49)`, base `main`, head **`3bfa12af2ff67cf07086d2fa9707780564a064d0`**, two commits (`d7745f2` the feature, `3bfa12a` a comment fix for Greptile). Reviewer `sebapoole` requested; `mergeable=MERGEABLE`, blocked only on `REVIEW_REQUIRED`. Not merged, not force-pushed, no stash. Worktree `gra-49` is clean and left in place; the main graft checkout and Cando's tree were never touched.

**CI**: `Typecheck, Lint & Test` **pass** (4m29s) on `3bfa12a`, CLA pass, Greptile Review pass. **Greptile**: confidence **5/5** after re-review of `3bfa12a`, "no outstanding correctness, security, or repository-rule issues". Its one P2 comment (Cando's "obliques are not shipped: nothing asks for italic" is contradicted by two pending-action blockquotes that apply `italic`) was addressed by appending the local consequence to that comment — Cando holds no oblique file to copy, and Cando's own `ai.$chatId.tsx` renders one `italic` line under the same declarations — with a reasoned reply on the thread, which is resolved.

**Linear**: GRA-49 moved to **In Review**, PR #27 attached.

**Byte-identical check** (SHA-256; copy = Cando `origin/main:packages/ui/src/styles/fonts/`, all six pairs equal):
- `gt-standard-l-300.woff2` `c370a3e6707dc7399339b8ffff9f1ae023997f33713d5b5c71a9d75a0af752a9`
- `gt-standard-l-400.woff2` `bf440c0e353931b05a1d9eb5eb1233376c9fee8652f8caab2a894bed99aed94b`
- `gt-standard-l-500.woff2` `86113c7f8a38e6101fa507860fcf89412a1766f3f2b5a2664e6ef3632d2117a6`
- `gt-standard-l-600.woff2` `95e4f212e167e5793107cea88ff4f01ac1fc97c70c0f4033cc4fed526f357455`
- `gt-standard-l-700.woff2` `e2edce2371c9debbc364aa285263a07f13867c2f1b2db6c463d73a6beb3594c9`
- `gt-standard-mono-vf.woff2` `c43e275ba527cfb3f0f312eeb562a38ae2309593a83011e1d14e0a1fd4504a43`

**Font verification** (Vite on :3001 against Docker :3100, throwaway `playwright-core` with `channel: "chrome"`, signed in as the admin):
- Five distinct `.woff2` requested across `/login` and `/agents` (weight 300 never requested — nothing uses it), every first response **200**; later 304s are Vite's `no-cache` on `/src/**` revalidating on navigation.
- `document.fonts.check('16px "GT Standard L"')` **true**; the six faces enumerate with weights 300/400/500/600/700 and **`300 900`** for the mono.
- `getComputedStyle(document.body).fontFamily` = `"GT Standard L", ui-sans-serif, system-ui, sans-serif`.
- The `<code>` on `/agents` computes to `"GT Standard Mono VF", …` at weight 400; canvas ink test in the mono face: **3686 px at 300, 4106 at 400, 6598 at 900** — the axis follows the CSS weight, so 400 is not Black.
- The 390-wide shell nav wraps "Pending actions" and clips "Settings"; the same shot with `.woff2` aborted (all faces `status: error`, i.e. `main`'s fallback rendering) is identical, so that is pre-existing, not a font regression.
- Built `dist/assets` contains the six hashed `.woff2` files (`check-types` output).

**Screenshots** under graft-cloud `docs/screens/gra-49/`: `login-{1440x1024,390x844}-{light,dark}.png`, `agents-{1440x1024,390x844}-{light,dark}.png`, `agents-code-crop.png`, and `baseline-nofonts-agents-{1440x1024-light,390x844-light,390x844-dark}.png`.

**Gate** (worktree root): `check` no fixes; `lint` clean (two pre-existing server warnings); `check-types` green; `test --force` 18/18, **`Cached: 0`**, integration suite ran on the compose Postgres :5440 (8 tests); `check-colours` clean; `check-tokens` 33 utilities all resolve; CI's conflict-marker and ADR checks pass.

**Deviations to know about**: beyond the header comment, I updated three other claims that this change made false — the `@theme inline` font comment in `index.css`, the "GT Standard" sentence in `AGENTS.md`'s console section, and ADR 0017's "fonts are named and not shipped" consequence (now past tense with the resolution appended) — and, for Greptile, appended a Graft-specific paragraph to Cando's `@font-face` comment; the six rules themselves are verbatim. **Still owed**: GRA-45's #26 is open and edits the adjacent header lines, so whichever lands second needs a hand merge of `origin/main`.