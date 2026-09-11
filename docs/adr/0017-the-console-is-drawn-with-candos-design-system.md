---
status: accepted
---

# The console is drawn with Cando's design system

The console (`apps/web`) is drawn with **Cando's design system as Cando's `packages/ui` implements
it**: its colour tokens in both modes, its type stacks, its Material Symbols icon set generated the
same way, its theme mechanism, and — as GRA-45 lands them — its primitives. Graft designs nothing of
its own here. Where the system has a pattern, a screen is composed from it; where it has none, the
screen is composed from the nearest pattern and the choice is written down.

**Figma stays upstream, in Cando.** The tokens between the `cando:tokens:start`/`end` sentinels in
`apps/web/src/index.css` are a copy of the managed block that Cando's `cando-import-variables` skill
writes from its design-system file. Graft does not read Figma. A token change is made in Figma,
imported into Cando, and copied here as a whole block — never edited by hand in either place, and
never re-derived from the file with a second importer, because two importers over one file drift.

**No Graft frames exist.** Cando's frames draw Cando's screens; none draws a console for agents,
connections and pending actions. So a Graft screen is *composed* from the system's patterns rather
than matched to a frame, and every pull request that adds or changes a screen carries a **delta
list**: which pattern each part was composed from, and where and why it departs. Cando's ADR 0008
(*Figma is the source of truth*) produces that list by comparing a screenshot against a frame; here
there is no frame, so the list stands alone and says so.

**Cando's product-specific pieces are not ported.** The agent rail with its bloom faces and the
`--agent-*` tint palette, the chat surfaces (composer, bubbles, message scroller,
`--shadow-chat-input`), and the two `@utility` sheens that exist for the disc and the default
Button — the first of which arrives with Cando's `button.tsx` under GRA-45, not here. The header of
`index.css` names each omission so a reader diffing the two files knows what is missing and why.

## Considered options

- **Keep shadcn's neutral defaults**, which is what the console shipped with. Rejected: the console
  is the one channel to the person for every harness (ADR 0006), and a person who also uses Cando
  meets two products from one company that look like two companies. The defaults were a placeholder
  while there was nothing to align to; there is.
- **Depend on `@cando/ui` as a package.** Rejected by ADR 0011: no live dependency in either
  direction while the tenancy model is reshaped, and Cando is to adopt Graft later, not the reverse.
  A copy that is re-read as it is copied is the arrangement every other Cando-derived piece has.
- **Import the Figma variables directly with Cando's skill.** Rejected: it puts two importers over
  one design file, and a difference between their outputs has no owner. One importer, in Cando; one
  copy, here.
- **A Graft identity of its own.** Deferred, not rejected. The alpha's users are Hermes people
  (ADR 0016), and nothing about the loop is served by a second visual language today. If one is
  wanted, it is made in Figma first and imported the same way.

## Consequences and accepted risks

- **The fonts were named before they were shipped.** `--font-sans`, `--font-heading` and
  `--font-mono` are Cando's literal stacks — GT Standard L and GT Standard Mono VF first, system
  faces after — so nothing else moved the day the files landed. Until GRA-49 confirmed the licence
  covers Graft there was no `@font-face` and no font file in the repository; the console rendered in
  the system fallback and requested no missing file, because shipping the faces on Cando's licence
  would have been a breach, not a shortcut. Aleks confirmed on 2026-09-11 that the licence covers
  Graft, and the six `.woff2` files and Cando's `@font-face` block now ship under `apps/web/src/`.
- **Two guards are the mechanism that makes dark mode correct**, and CI runs both. Cando's ADR 0008
  records why: its frames are light-only, dark ships derived from the tokens and is never verified
  per screen, so a hard-coded colour is invisible in light and broken in dark with nothing else
  that would catch it. Graft is in the same position with less, since it has no frame at all.
  `check-colours` (`apps/web/scripts/check-design-tokens.mjs`) reports a colour literal in a
  component, a colour literal inside `@theme` where a mode is impossible, and a base token identical
  across modes while its derived family flips; `check-tokens`
  (`apps/web/scripts/check-token-utilities.mjs`) reports a design-token utility that does not
  compile into the built CSS, because Tailwind emits nothing for an unknown utility. The logic is
  Cando's, copied into `apps/web/src/tokens/` with its unit tests, and the scan covers `index.html`
  beside the TypeScript tree since it is a build input like any component. Exceptions are one
  central list, `COLOUR_EXCEPTIONS`, never an inline comment; today it holds only the two
  `theme-color` hexes — in `index.html` and in `theme-provider.tsx` — which a `<meta>` attribute
  cannot take as a `var()`.
- **Copied text is re-read, not trusted** (ADR 0011). Every comment in the copied CSS, provider,
  generator and guards is repointed at this repository's decisions; where the argument lives in
  Cando, the comment names the Cando file or ticket rather than restating it.
- **A re-sync is manual.** A change in Cando's managed block reaches the console only when someone
  copies it. Accepted: the block changes rarely, and the copy is a diff a reviewer can read in one
  screen.
- **The console reads as Cando.** Accepted for the alpha, and the deferred option above is the way
  out if it stops being wanted.
