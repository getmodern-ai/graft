# Survey: the Cando design system as expressed in code (read-only, 2026-09-11)

Written by an Explore agent from `origin/main` (78c94829) of a Cando checkout (the working tree was stale; files were read with `git show origin/main:<path>`). Facts with file paths; CSS verbatim.

## Cando design system — code survey

**Source note.** The Cando checkout's HEAD is `5310b6f9` (Wed Aug 19 2026) but `origin/main` is `78c94829` (Thu Sep 10 2026) — the checkout is stale. **Everything below was read from `origin/main` via `git show`**, not the working tree. Paths are given repo-relative. A second Cando checkout, at `77a8986d` (Sep 5) and also behind, was used only to read `node_modules`.

---

## 0. Stack facts that gate everything else

- **Tailwind v4** (`tailwindcss: ^4.3.2` via pnpm catalog, `pnpm-workspace.yaml`). **CSS-first — there is no `tailwind.config.*` anywhere.** `components.json` explicitly sets `"tailwind": { "config": "" }`.
- Build: `@tailwindcss/vite` in `apps/web/vite.config.ts`; `packages/ui/postcss.config.mjs` is `{ plugins: { "@tailwindcss/postcss": {} } }`.
- The token file is `packages/ui/src/styles/globals.css`, exported as `@cando/ui/globals.css` and imported by `apps/web/src/index.css`.
- Primitives are built on **Base UI** (`@base-ui/react ^1.7.0`) + `@shadcn/react ^0.3.0` + `shadcn ^4.19.0` (the CLI package also ships `shadcn/tailwind.css`, which globals.css imports). Not Radix.
- `cn` = `twMerge(clsx(...))` — `packages/ui/src/lib/utils.ts`.
- App: Vite + React 19 + TanStack Router (file routes, `routeTree.gen.ts`) + TanStack Query + oRPC. Ports: web 3001, server 3000, advisor 3002.

---

## 1. Tokens — `packages/ui/src/styles/globals.css` (verbatim, complete)

The file is 607 lines. Reproduced in full below, in order, with all comments (they carry load-bearing rationale).

### 1.1 Imports, sources, dark variant

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@source "../../../apps/**/*.{ts,tsx}";
@source "../**/*.{ts,tsx}";

@custom-variant dark (&:is(.dark *));
```

`shadcn/tailwind.css` (from the `shadcn@4.19.0` package, `dist/tailwind.css`, 629 lines) supplies the `@custom-variant`s the primitives use everywhere: `data-open`, `data-closed`, `data-checked`, `data-unchecked`, `data-selected`, `data-disabled`, `data-active`, `data-horizontal`, `data-vertical`; plus `@utility no-scrollbar`, accordion keyframes, and `--scroll-fade-*` `@property` declarations. **If you replicate this design system you must import that file too, or `data-open:`/`data-horizontal:` etc. silently compile to nothing.**

### 1.2 Two custom `@utility` gradients (+ their mode-varying variable)

```css
/* The default Button's hover wash: a flat 8% white over the fill, read off the
 * Button component's `variant=default, state=hover` node. The redesign (CAN-291)
 * flattened the old top-dark/bottom-light sheen — solid fills are now plain, and
 * this is the one gradient the component still carries, applied as
 * `hover:button-sheen` by the default variant only; secondary and destructive
 * hover change nothing but shadow. One value for both modes, because its only
 * substrate is `--primary`, the same orange in both.
 *
 * `@utility` rather than a `@theme` entry, because Tailwind v4 has no
 * `--background-image-*` namespace — declaring one there compiles silently and
 * produces no class at all.
 *
 * **Not named `bg-…` on purpose.** `cn` runs tailwind-merge, which reads any
 * `bg-*` class as a background and keeps only the last one, so a `bg-button-sheen`
 * would fight `bg-primary` and lose. They set different properties and must both
 * survive, so the name stays outside that namespace.
 *
 * A gradient over the fill rather than `hover:bg-primary/92`: alpha on the fill
 * would let the surface underneath bleed through, and the frame lightens the fill
 * itself. */
@utility button-sheen {
  background-image: linear-gradient(oklch(1 0 0 / 8%), oklch(1 0 0 / 8%));
}

/* The agent disc's sheen, read off the rail's 36px discs: a 5% dark cap over the
 * top quarter and a 20% white lift over the lower half. (The Button used to carry
 * the same treatment; CAN-291 flattened it there, and the rail frames kept it.)
 *
 * **Why this one gets a mode and the one above does not.** `button-sheen` has one
 * caller — `button.tsx`, which pairs it with `bg-primary` — so its substrate is a
 * solid brand fill, the same orange in both modes; a fixed white wash reads the
 * same in both. (Grep it before relying on that: a second caller over a
 * mode-varying fill would put `button-sheen` in the same position this utility is
 * in.) The disc sits
 * on `--muted`, which goes from `oklch(0.977 …)` to `oklch(0.295 …)`. A cap fixed at
 * 5% black therefore vanishes in dark while the 20% white lift becomes the loudest
 * thing on the rail — which is what `agent-switcher.tsx` shipped as an inlined
 * `bg-[linear-gradient(…rgb(0_0_0/5%)…)]` before CAN-179. Measured on the
 * unselected disc at 1440, the lift took the bottom of a 48,44,41 substrate to
 * 82,80,77 while the cap moved it by 1. Flipping the two per mode keeps the cap and
 * the lift the same distance from the substrate on both sides: light renders
 * exactly as it does today, dark renders its mirror.
 *
 * The value is a variable with a `:root` and a `.dark` entry rather than
 * `color-mix(in oklab, var(--foreground) 5%, transparent)`, which was tried first.
 * That form works, but Lightning CSS emits a pre-`color-mix` fallback for it that
 * drops the alpha — an *opaque* foreground gradient over the disc in any browser
 * that fails the feature test. A literal per mode has no fallback to get wrong,
 * and it also keeps light byte-identical to the Figma fill.
 *
 * **Not named `bg-…`, for the reason recorded on `button-sheen`** — and here it is
 * load-bearing rather than precautionary. The disc carries `bg-muted` in the same
 * `cn()` call *after* the sheen, so a `bg-*`-namespaced sheen would be dropped by
 * tailwind-merge outright. That is also why the fix is not `upgrade-plans.tsx`'s
 * flat `bg-foreground/5`: that gradient was on a tray with no other background to
 * lose to. */
:root {
  --agent-disc-sheen:
    linear-gradient(to bottom, oklch(0 0 0 / 5%) 0%, oklch(0 0 0 / 0%) 25%),
    linear-gradient(to bottom, oklch(1 0 0 / 0%) 50%, oklch(1 0 0 / 20%) 100%);
}

.dark {
  --agent-disc-sheen:
    linear-gradient(to bottom, oklch(1 0 0 / 5%) 0%, oklch(1 0 0 / 0%) 25%),
    linear-gradient(to bottom, oklch(0 0 0 / 0%) 50%, oklch(0 0 0 / 20%) 100%);
}

@utility agent-disc-sheen {
  background-image: var(--agent-disc-sheen);
}
```

### 1.3 Fonts — `@font-face`, self-hosted

```css
/* GT Standard L — licensed from Grilli Type, self-hosted. Obliques are not
 * shipped: nothing in the design system asks for italic. The mono is a variable
 * font whose wght axis runs 300–900 but *defaults to 900*, so the range below is
 * load-bearing — without it every mono glyph renders Black. */
@font-face {
  font-family: "GT Standard L";
  src: url("./fonts/gt-standard-l-300.woff2") format("woff2");
  font-weight: 300;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "GT Standard L";
  src: url("./fonts/gt-standard-l-400.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "GT Standard L";
  src: url("./fonts/gt-standard-l-500.woff2") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "GT Standard L";
  src: url("./fonts/gt-standard-l-600.woff2") format("woff2");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "GT Standard L";
  src: url("./fonts/gt-standard-l-700.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "GT Standard Mono VF";
  src: url("./fonts/gt-standard-mono-vf.woff2") format("woff2");
  font-weight: 300 900;
  font-style: normal;
  font-display: swap;
}
```

### 1.4 The managed token block — `:root` and `.dark` (87 colour tokens each)

```css
/* cando:tokens:start. Managed by cando-import-variables. Edit source tokens, not this block.
 *
 * The complete Mode collection — all 87 colour tokens, both modes — generated
 * from Figma. Names mirror the Figma variable path exactly, with `/` as `-`, so
 * `--custom-bg-input-30` is `custom/bg-input-30` and nothing needs translating in
 * either direction.
 *
 * Regenerate with `node scripts/mode-collection-oklch.mjs` — that script holds the
 * dump, the conversion and the two departures below, so a re-sync is a re-run and
 * a diff rather than a hand edit.
 *
 * A source oddity is imported faithfully rather than tidied, and is worth knowing
 * before anyone "fixes" it here: the source moved the **solid** primary fill to
 * #fd6a41 but left every tinted variant — `custom/bg-primary-*`,
 * `custom/border-primary-*` — plus `focus` and `ring-focus` on the previous
 * #fd5a2a. Verified against three components that bind both (Button, Checkbox,
 * Radio Group), so it is the source's state, not an import error.
 *
 * **Two dark values depart from the source (CAN-130, 2026-08-18), because the
 * source is broken there and importing it verbatim would ship worse contrast than
 * the bug it was meant to fix.** Both are mis-aimed aliases, not disagreements
 * about colour:
 *
 * - `destructive` dark aliases `Style:color/dark/custom/destructive-focus`, a
 *   40%-alpha focus-ring style rather than a solid. Verbatim it renders "Failed"
 *   on `/automations/history` at 1.67:1, against 3.35:1 before and 4.5:1 required.
 *   Every other dark destructive token draws its hue from `color/brand/red/500`
 *   (#f53039 -> oklch(0.63 0.2294 25.06)), so that solid is the evident intent; it
 *   measures 4.98:1 on the background and 4.60:1 on a card.
 * - `destructive-foreground` dark aliases `Style:color/light/destructive` — the
 *   light mode's dark red, i.e. the destructive *surface* used as its own
 *   foreground, at 2.01:1. White is kept, which is also the source's light value.
 *
 * Consequence worth knowing: `bg-destructive` + `text-destructive-foreground` (the
 * destructive Button, the token pair's only surface use) moves from 5.82:1 to
 * 3.91:1 in dark, and 3.91:1 is the *ceiling* for white on red/500. Dark
 * destructive cannot be both a 4.5:1 text colour and a 4.5:1 button surface with
 * one token; splitting it is a design-system decision and is raised in Figma
 * rather than invented here. `text-destructive` — every field error, alert,
 * destructive menu item and the "Failed" status — is the dominant use and is what
 * this fixes. */
:root {
  --radius: 0.625rem;
  --accent: oklch(0.963 0.0042 56.37);
  --accent-foreground: oklch(0.25 0.0072 67.49);
  --background: oklch(1 0 0);
  --border: oklch(0.928 0.0068 53.44);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.157 0.0066 55.82);
  --chart-chart-1: oklch(0.701 0.1885 36.31);
  --chart-chart-2: oklch(0.672 0.1574 246.5);
  --chart-chart-3: oklch(0.642 0.2122 302.97);
  --chart-chart-4: oklch(0.745 0.1539 159.02);
  --chart-chart-5: oklch(0.82 0.1433 72.83);
  --custom-bg-destructive-10: oklch(0.531 0.1933 25.14 / 10%);
  --custom-bg-destructive-20: oklch(0.531 0.1933 25.14 / 20%);
  --custom-bg-input-100-80: oklch(0.928 0.0068 53.44);
  --custom-bg-input-20-30: oklch(0.893 0.0094 52.09 / 20%);
  --custom-bg-input-20-50: oklch(0.893 0.0094 52.09 / 20%);
  --custom-bg-input-30: oklch(0.893 0.0094 52.09 / 30%);
  --custom-bg-input-30-50: oklch(0.893 0.0094 52.09 / 30%);
  --custom-bg-input-30-trans-light: oklch(1 0 0);
  --custom-bg-input-50: oklch(0.893 0.0094 52.09 / 50%);
  --custom-bg-input-50-trans-light: oklch(1 0 0);
  --custom-bg-input-80: oklch(0.893 0.0094 52.09 / 80%);
  --custom-bg-input-90: oklch(0.893 0.0094 52.09 / 90%);
  --custom-bg-muted-50: oklch(0.977 0.0034 67.78 / 50%);
  --custom-bg-primary-10: oklch(0.68 0.2071 36.25 / 10%);
  --custom-bg-primary-5: oklch(0.68 0.2071 36.25 / 5%);
  --custom-bg-primary-80: oklch(0.68 0.2071 36.25 / 80%);
  --custom-bg-secondary-80: oklch(0.977 0.0034 67.78 / 80%);
  --custom-border-50: oklch(0.928 0.0068 53.44 / 50%);
  --custom-border-primary-30: oklch(0.68 0.2071 36.25 / 30%);
  --custom-border-primary-checked: oklch(0.68 0.2071 36.25 / 30%);
  --custom-border-subtle: oklch(0.157 0.0066 55.82 / 5%);
  --custom-brand-amber: oklch(0.82 0.1433 72.83);
  --custom-brand-blue: oklch(0.672 0.1574 246.5);
  --custom-brand-green: oklch(0.745 0.1539 159.02);
  --custom-brand-orange: oklch(0.701 0.1885 36.31);
  --custom-brand-purple: oklch(0.642 0.2122 302.97);
  --custom-brand-red: oklch(0.63 0.2294 25.06);
  --custom-dark-input: oklch(1 0 0 / 0%);
  --custom-destructive-70: oklch(0.531 0.1933 25.14 / 70%);
  --custom-destructive-90: oklch(0.531 0.1933 25.14 / 90%);
  --custom-destructive-border-40: oklch(0.531 0.1933 25.14 / 40%);
  --custom-destructive-focus: oklch(0.531 0.1933 25.14 / 20%);
  --custom-foreground-10: oklch(0.157 0.0066 55.82 / 10%);
  --custom-foreground-5: oklch(0.157 0.0066 55.82 / 5%);
  --custom-foreground-5-10: oklch(0.157 0.0066 55.82 / 5%);
  --custom-foreground-70: oklch(0.157 0.0066 55.82 / 70%);
  --custom-muted-foreground-10: oklch(0.524 0.0078 53.34 / 10%);
  --custom-switch-off-thumb-bg: oklch(1 0 0);
  --custom-switch-on-thumb-bg: oklch(1 0 0);
  --destructive: oklch(0.531 0.1933 25.14);
  --destructive-foreground: oklch(1 0 0);
  --foreground: oklch(0.157 0.0066 55.82);
  --info: oklch(0.471 0.1106 246.53);
  --info-foreground: oklch(0.99 0.0051 247.88);
  --info-ring: oklch(0.84 0.0764 246.41);
  --input: oklch(0.802 0.0088 56.28);
  --muted: oklch(0.977 0.0034 67.78);
  --muted-foreground: oklch(0.524 0.0078 53.34);
  --opacity-100: oklch(1 0 0 / 0%);
  --opacity-30: oklch(1 0 0 / 70%);
  --opacity-50: oklch(1 0 0 / 50%);
  --opacity-80: oklch(1 0 0 / 20%);
  --opacity-90: oklch(1 0 0 / 10%);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.157 0.0066 55.82);
  --primary: oklch(0.701 0.1885 36.31);
  --primary-foreground: oklch(0.157 0.0066 55.82);
  --ring: oklch(0.68 0.2071 36.25);
  --ring-focus: oklch(0.68 0.2071 36.25 / 50%);
  --secondary: oklch(0.977 0.0034 67.78);
  --secondary-foreground: oklch(0.25 0.0072 67.49);
  --sidebar-accent: oklch(0.963 0.0042 56.37);
  --sidebar-accent-foreground: oklch(0.25 0.0072 67.49);
  --sidebar-border: oklch(0.928 0.0068 53.44);
  --sidebar-foreground: oklch(0.157 0.0066 55.82);
  --sidebar-primary: oklch(0.68 0.2071 36.25);
  --sidebar-primary-foreground: oklch(0.157 0.0066 55.82);
  --sidebar-ring: oklch(0.68 0.2071 36.25 / 64%);
  --sidebar-sidebar: oklch(0.989 0.0017 67.8);
  --success: oklch(0.448 0.1083 151.33);
  --success-80: oklch(0.448 0.1083 151.33 / 80%);
  --success-foreground: oklch(0.972 0.0368 159.02);
  --success-ring: oklch(0.869 0.1798 158.99);
  --warning: oklch(0.52 0.1047 73);
  --warning-foreground: oklch(0.99 0.0068 67.75);
  --warning-ring: oklch(0.898 0.0769 72.94);
}

.dark {
  --accent: oklch(0.34 0.0066 48.52);
  --accent-foreground: oklch(0.963 0.0042 56.37);
  --background: oklch(0.157 0.0066 55.82);
  --border: oklch(0.434 0.0072 59.51);
  --card: oklch(0.203 0.0062 56.01);
  --card-foreground: oklch(0.963 0.0042 56.37);
  --chart-chart-1: oklch(0.701 0.1885 36.31);
  --chart-chart-2: oklch(0.728 0.1345 246.08);
  --chart-chart-3: oklch(0.703 0.1715 302.76);
  --chart-chart-4: oklch(0.786 0.1619 159.19);
  --chart-chart-5: oklch(0.846 0.1202 73.24);
  --custom-bg-destructive-10: oklch(0.63 0.2294 25.06 / 10%);
  --custom-bg-destructive-20: oklch(0.63 0.2294 25.06 / 20%);
  --custom-bg-input-100-80: oklch(0.963 0.0042 56.37 / 12%);
  --custom-bg-input-20-30: oklch(0.963 0.0042 56.37 / 5%);
  --custom-bg-input-20-50: oklch(0.963 0.0042 56.37 / 9%);
  --custom-bg-input-30: oklch(0.963 0.0042 56.37 / 5%);
  --custom-bg-input-30-50: oklch(0.963 0.0042 56.37 / 9%);
  --custom-bg-input-30-trans-light: oklch(0.963 0.0042 56.37 / 4%);
  --custom-bg-input-50: oklch(0.963 0.0042 56.37 / 9%);
  --custom-bg-input-50-trans-light: oklch(0.963 0.0042 56.37 / 9%);
  --custom-bg-input-80: oklch(0.963 0.0042 56.37 / 13%);
  --custom-bg-input-90: oklch(0.963 0.0042 56.37 / 15%);
  --custom-bg-muted-50: oklch(0.295 0.0069 67.56 / 50%);
  --custom-bg-primary-10: oklch(0.68 0.2071 36.25 / 10%);
  --custom-bg-primary-5: oklch(0.68 0.2071 36.25 / 10%);
  --custom-bg-primary-80: oklch(0.68 0.2071 36.25 / 80%);
  --custom-bg-secondary-80: oklch(0.295 0.0069 67.56 / 80%);
  --custom-border-50: oklch(0.295 0.0069 67.56 / 50%);
  --custom-border-primary-30: oklch(0.68 0.2071 36.25 / 20%);
  --custom-border-primary-checked: oklch(0.68 0.2071 36.25 / 20%);
  --custom-border-subtle: oklch(0.963 0.0042 56.37 / 10%);
  --custom-brand-amber: oklch(0.82 0.1433 72.83);
  --custom-brand-blue: oklch(0.672 0.1574 246.5);
  --custom-brand-green: oklch(0.745 0.1539 159.02);
  --custom-brand-orange: oklch(0.701 0.1885 36.31);
  --custom-brand-purple: oklch(0.642 0.2122 302.97);
  --custom-brand-red: oklch(0.63 0.2294 25.06);
  --custom-dark-input: oklch(0.963 0.0042 56.37 / 15%);
  --custom-destructive-70: oklch(0.63 0.2294 25.06 / 70%);
  --custom-destructive-90: oklch(0.63 0.2294 25.06 / 90%);
  --custom-destructive-border-40: oklch(0.63 0.2294 25.06 / 40%);
  --custom-destructive-focus: oklch(0.63 0.2294 25.06 / 40%);
  --custom-foreground-10: oklch(0.963 0.0042 56.37 / 10%);
  --custom-foreground-5: oklch(0.963 0.0042 56.37 / 5%);
  --custom-foreground-5-10: oklch(0.963 0.0042 56.37 / 10%);
  --custom-foreground-70: oklch(0.963 0.0042 56.37 / 70%);
  --custom-muted-foreground-10: oklch(0.71 0.0091 56.26 / 10%);
  --custom-switch-off-thumb-bg: oklch(0.963 0.0042 56.37);
  --custom-switch-on-thumb-bg: oklch(1 0 0);
  --destructive: oklch(0.63 0.2294 25.06);
  --destructive-foreground: oklch(1 0 0);
  --foreground: oklch(0.963 0.0042 56.37);
  --info: oklch(0.783 0.1049 246.49);
  --info-foreground: oklch(0.172 0.0403 245.18);
  --info-ring: oklch(0.371 0.0869 246.57);
  --input: oklch(0.524 0.0078 53.34);
  --muted: oklch(0.295 0.0069 67.56);
  --muted-foreground: oklch(0.71 0.0091 56.26);
  --opacity-100: oklch(0 0 0 / 0%);
  --opacity-30: oklch(0 0 0 / 70%);
  --opacity-50: oklch(0 0 0 / 50%);
  --opacity-80: oklch(0 0 0 / 20%);
  --opacity-90: oklch(0 0 0 / 10%);
  --popover: oklch(0.25 0.0072 67.49);
  --popover-foreground: oklch(0.963 0.0042 56.37);
  --primary: oklch(0.701 0.1885 36.31);
  --primary-foreground: oklch(0.157 0.0066 55.82);
  --ring: oklch(0.701 0.1885 36.31);
  --ring-focus: oklch(0.701 0.1885 36.31 / 50%);
  --secondary: oklch(0.295 0.0069 67.56);
  --secondary-foreground: oklch(0.928 0.0068 53.44);
  --sidebar-accent: oklch(0.295 0.0069 67.56);
  --sidebar-accent-foreground: oklch(0.963 0.0042 56.37);
  --sidebar-border: oklch(0.295 0.0069 67.56);
  --sidebar-foreground: oklch(0.893 0.0094 52.09);
  --sidebar-primary: oklch(0.68 0.2071 36.25);
  --sidebar-primary-foreground: oklch(0.157 0.0066 55.82);
  --sidebar-ring: oklch(0.701 0.1885 36.31 / 64%);
  --sidebar-sidebar: oklch(0.203 0.0062 56.01);
  --success: oklch(0.627 0.1699 149.21);
  --success-80: oklch(0.627 0.1699 149.21 / 80%);
  --success-foreground: oklch(0.247 0.0516 157.94);
  --success-ring: oklch(0.445 0.0918 159.1);
  --warning: oklch(0.846 0.1202 73.24);
  --warning-foreground: oklch(0.32 0.0643 73.96);
  --warning-ring: oklch(0.52 0.1047 73);
}
/* cando:tokens:end */
```

### 1.5 Agent tint palette (outside the managed block, single-valued / mode-invariant)

```css
/* The AgentImages tint palette.
 *
 * Deliberately outside the managed block above: that block is generated from the
 * whole Mode collection, and these come from Style instead. Regenerating Mode
 * must not clobber them.
 *
 * Named for the component's own variant axis (`Type=Orange Light`) rather than
 * the palette path underneath it (`Orange/300`). Mirroring the path would mean
 * defining `--orange-300` but not `--orange-400`, so `orange-300` would be the
 * brand ramp while `orange-400` stayed Tailwind's — a partial shadow that reads
 * as a bug the first time someone hits the seam. The variant name is also what a
 * caller actually picks, so it is the more useful thing to keep 1:1.
 *
 * Single-valued on purpose: each has one mode in Figma, so "Light"/"Dark" here
 * means a lighter or darker tint, NOT a light/dark colour scheme. They do not
 * change between themes.
 *
 * Sourced from Figma: Orange/300, Orange/500, Amber/300, Amber/500, Purple/300,
 * Purple/500, Blue/300, Blue/500, color/brand/green/300, color/brand/green/500.
 * Green is the odd one out — it lives under `color/brand/green/*` in a different
 * collection from the other four ramps. Normalised here; worth aligning in Figma.
 */
:root {
  --agent-orange-light: oklch(0.801 0.1144 36.1); /* #fea38a */
  --agent-orange-dark: oklch(0.701 0.1885 36.31); /* #fd6a41 */
  --agent-amber-light: oklch(0.872 0.0988 72.8); /* #fdcb8b */
  --agent-amber-dark: oklch(0.82 0.1433 72.83); /* #fcb44d */
  --agent-purple-light: oklch(0.764 0.1326 302.6); /* #c39df8 */
  --agent-purple-dark: oklch(0.642 0.2122 302.97); /* #a862f4 */
  --agent-blue-light: oklch(0.783 0.1049 246.49); /* #7fbff8 */
  --agent-blue-dark: oklch(0.672 0.1574 246.5); /* #2c9cf0 */
  /* Identical to `--success` — brand green 300 and the success token are the
   * same colour in Figma. Kept separate so changing one does not move the other. */
  --agent-green-light: oklch(0.827 0.1707 159.02); /* #42e79d */
  --agent-green-dark: oklch(0.745 0.1539 159.02); /* #38c988 */
}
```

### 1.6 Shadows and the scrim (mode-varying, outside the managed block)

```css
/* Effects and overlays that no Figma *variable* stands behind — they are read off
 * component effects and frame fills instead — and which therefore have to be given
 * a mode here rather than imported with one.
 *
 * Outside the managed block for the same reason as the tint palette above: that
 * block is generated from the Mode collection and a re-sync would clobber
 * anything else in it. Unlike the tints, though, these are *not* mode-invariant.
 * They were previously declared straight inside `@theme` with literal
 * `oklch(0 0 0 / …)` values, which put them outside both `:root` and `.dark` and
 * left them with no dark counterpart at all — CAN-179.
 *
 * The raw names here are deliberately not the `@theme` keys below. A `@theme` key
 * called `--shadow-button` cannot be defined as `var(--shadow-button)` without a
 * self-reference, which is the same reason the managed block pairs `--primary`
 * with `--color-primary` instead of reusing one name.
 *
 * **What gets a `.dark` value is what lands on the page.** An inset bevel sits on
 * the control's own fill, and the solid fills it is used over — `--primary`,
 * `--secondary`, `--destructive` — are either identical across modes or dark
 * enough that 20% black still reads, so the bevel keeps a single value. A cast
 * shadow falls on `--background`, which goes from `oklch(1 0 0)` to
 * `oklch(0.157 …)`, and 5% black on that removes nothing.
 *
 * The dark alphas are computed rather than picked. 5% black over white removes
 * ΔL 0.038 of oklch lightness; reproducing that removal over the dark page's
 * 12.6/255 grey takes 55%. 6% → 65% and 10% → 85% by the same arithmetic. Two
 * caveats kept with the numbers: the page is the *darkest* substrate any of these
 * land on (`--card` is 22.6/255, `--popover` lighter still), so on a card they
 * slightly overshoot — which is the safe direction for a shadow — and the scrim
 * below deliberately does not follow the rule. */
:root {
  /* The bevel is 1px at rest and deepens to 2px on hover — the DS Button's enabled
   * state pads 1px, its hover state 2px (CAN-291). Disabled is the rest shadow
   * faded by the element's own opacity, so it needs no token of its own. */
  --button-shadow: inset 0 -1px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 5%);
  --button-shadow-hover:
    inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 4px 6px -2px oklch(0 0 0 / 5%),
    0 10px 15px -3px oklch(0 0 0 / 10%);
  --chat-input-shadow: 0 4px 16px 0 oklch(0 0 0 / 6%);

  /* The modal scrim, one token for the four overlays that used to hard-code
   * `bg-black/10` each (`Dialog`, `AlertDialog`, `Sheet`, `Drawer`).
   *
   * Black in both modes on purpose, and the one value here that is not derived
   * from the ΔL arithmetic above. A scrim dims what is behind it; `--foreground`
   * would invert to a white veil in dark, which *raises* the page towards the
   * `--popover` surface sitting on it and removes the separation instead of
   * adding it. So the token varies its alpha per mode rather than its hue, which
   * is the whole reason it has to be a token and not a utility.
   *
   * 10% is the light weight the frames were verified against at 1440. Matched on
   * ΔL, dark would want 85%, which under `backdrop-blur-xs` reads as a blackout
   * rather than a scrim; 60% removes ΔL 0.042 — over half the light step, plainly
   * present, and the same order as shadcn's own `/50` default. */
  --scrim: oklch(0 0 0 / 10%);
}

.dark {
  --button-shadow: inset 0 -1px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 55%);
  --button-shadow-hover:
    inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 4px 6px -2px oklch(0 0 0 / 55%),
    0 10px 15px -3px oklch(0 0 0 / 85%);
  --chat-input-shadow: 0 4px 16px 0 oklch(0 0 0 / 65%);
  --scrim: oklch(0 0 0 / 60%);
}
```

### 1.7 `@theme inline` — the Tailwind namespace mapping

```css
@theme inline {
  --color-agent-orange-light: var(--agent-orange-light);
  --color-agent-orange-dark: var(--agent-orange-dark);
  --color-agent-amber-light: var(--agent-amber-light);
  --color-agent-amber-dark: var(--agent-amber-dark);
  --color-agent-purple-light: var(--agent-purple-light);
  --color-agent-purple-dark: var(--agent-purple-dark);
  --color-agent-blue-light: var(--agent-blue-light);
  --color-agent-blue-dark: var(--agent-blue-dark);
  --color-agent-green-light: var(--agent-green-light);
  --color-agent-green-dark: var(--agent-green-dark);

  /* Literal stacks rather than the next/font bridge in project-setup.md — this is
   * a Vite app self-hosting the faces above, so there is no loader-defined
   * variable to alias, and a literal value cannot form the cyclic self-reference
   * that bridge doc warns about. */
  --font-sans: "GT Standard L", ui-sans-serif, system-ui, sans-serif;
  --font-heading: "GT Standard L", ui-sans-serif, system-ui, sans-serif;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-mono: "GT Standard Mono VF", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Solid buttons are not flat: an inset bottom bevel plus a small lift, both
   * deepening on hover. Taken from the effects on the Figma Button component,
   * which are applied directly rather than through a shadows/* style.
   *
   * The values live in `:root`/`.dark` above so they have a mode; these entries
   * only lift them into Tailwind's `--shadow-*` namespace, which is what makes
   * `shadow-button` a class. */
  --shadow-button: var(--button-shadow);
  --shadow-button-hover: var(--button-shadow-hover);
  /* The chat composer floats above the thread. Like the button bevel, this lives
   * on the Figma component rather than in a shadows/* style. */
  --shadow-chat-input: var(--chat-input-shadow);

  --color-scrim: var(--scrim);

  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-background: var(--background);
  --color-border: var(--border);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-chart-chart-1: var(--chart-chart-1);
  --color-chart-chart-2: var(--chart-chart-2);
  --color-chart-chart-3: var(--chart-chart-3);
  --color-chart-chart-4: var(--chart-chart-4);
  --color-chart-chart-5: var(--chart-chart-5);
  --color-custom-bg-destructive-10: var(--custom-bg-destructive-10);
  --color-custom-bg-destructive-20: var(--custom-bg-destructive-20);
  --color-custom-bg-input-100-80: var(--custom-bg-input-100-80);
  --color-custom-bg-input-20-30: var(--custom-bg-input-20-30);
  --color-custom-bg-input-20-50: var(--custom-bg-input-20-50);
  --color-custom-bg-input-30: var(--custom-bg-input-30);
  --color-custom-bg-input-30-50: var(--custom-bg-input-30-50);
  --color-custom-bg-input-30-trans-light: var(--custom-bg-input-30-trans-light);
  --color-custom-bg-input-50: var(--custom-bg-input-50);
  --color-custom-bg-input-50-trans-light: var(--custom-bg-input-50-trans-light);
  --color-custom-bg-input-80: var(--custom-bg-input-80);
  --color-custom-bg-input-90: var(--custom-bg-input-90);
  --color-custom-bg-muted-50: var(--custom-bg-muted-50);
  --color-custom-bg-primary-10: var(--custom-bg-primary-10);
  --color-custom-bg-primary-5: var(--custom-bg-primary-5);
  --color-custom-bg-primary-80: var(--custom-bg-primary-80);
  --color-custom-bg-secondary-80: var(--custom-bg-secondary-80);
  --color-custom-border-50: var(--custom-border-50);
  --color-custom-border-primary-30: var(--custom-border-primary-30);
  --color-custom-border-primary-checked: var(--custom-border-primary-checked);
  --color-custom-border-subtle: var(--custom-border-subtle);
  --color-custom-brand-amber: var(--custom-brand-amber);
  --color-custom-brand-blue: var(--custom-brand-blue);
  --color-custom-brand-green: var(--custom-brand-green);
  --color-custom-brand-orange: var(--custom-brand-orange);
  --color-custom-brand-purple: var(--custom-brand-purple);
  --color-custom-brand-red: var(--custom-brand-red);
  --color-custom-dark-input: var(--custom-dark-input);
  --color-custom-destructive-70: var(--custom-destructive-70);
  --color-custom-destructive-90: var(--custom-destructive-90);
  --color-custom-destructive-border-40: var(--custom-destructive-border-40);
  --color-custom-destructive-focus: var(--custom-destructive-focus);
  --color-custom-foreground-10: var(--custom-foreground-10);
  --color-custom-foreground-5: var(--custom-foreground-5);
  --color-custom-foreground-5-10: var(--custom-foreground-5-10);
  --color-custom-foreground-70: var(--custom-foreground-70);
  --color-custom-muted-foreground-10: var(--custom-muted-foreground-10);
  --color-custom-switch-off-thumb-bg: var(--custom-switch-off-thumb-bg);
  --color-custom-switch-on-thumb-bg: var(--custom-switch-on-thumb-bg);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-foreground: var(--foreground);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-info-ring: var(--info-ring);
  --color-input: var(--input);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-opacity-100: var(--opacity-100);
  --color-opacity-30: var(--opacity-30);
  --color-opacity-50: var(--opacity-50);
  --color-opacity-80: var(--opacity-80);
  --color-opacity-90: var(--opacity-90);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-ring: var(--ring);
  --color-ring-focus: var(--ring-focus);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-sidebar: var(--sidebar-sidebar);
  --color-success: var(--success);
  --color-success-80: var(--success-80);
  --color-success-foreground: var(--success-foreground);
  --color-success-ring: var(--success-ring);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-ring: var(--warning-ring);

  /* Compatibility aliases. The tokens above mirror Figma, but registry components
   * are written against the shadcn vocabulary — `bg-sidebar`, `fill-chart-1` —
   * which would otherwise resolve to nothing and fail silently. */
  --color-sidebar: var(--sidebar-sidebar);
  --color-chart-1: var(--chart-chart-1);
  --color-chart-2: var(--chart-chart-2);
  --color-chart-3: var(--chart-chart-3);
  --color-chart-4: var(--chart-chart-4);
  --color-chart-5: var(--chart-chart-5);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);
  --radius-4xl: calc(var(--radius) + 16px);
}
```

### 1.8 `@layer base`

```css
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply font-sans bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

### 1.9 Summary of the token facts you asked for

| Topic | Value |
|---|---|
| Tailwind version | v4 (`^4.3.2`), CSS-first, **no tailwind.config** |
| Mechanism | `@theme inline` + CSS variables in `:root`/`.dark`; `components.json` `cssVariables: true` |
| Base radius | `--radius: 0.625rem` (10px) |
| Radius scale | `sm = radius-4px` (6px), `md = radius-2px` (8px), `lg = radius` (10px), `xl = +4` (14px), `2xl = +8` (18px), `3xl = +12` (22px), `4xl = +16` (26px) |
| Shadows | Only three, all custom: `shadow-button`, `shadow-button-hover`, `shadow-chat-input`. No `--shadow-xs/sm/md/...` overrides — stock Tailwind applies. |
| Spacing scale | **No overrides.** No `--spacing` token; stock Tailwind 0.25rem. Radii/sizes are expressed in stock steps (`size-8`, `h-9`, `w-65`, `w-100` etc.). |
| Font variables | `--font-sans`, `--font-heading` (both GT Standard L), `--font-serif` (Georgia), `--font-mono` (GT Standard Mono VF) |
| Sidebar tokens | `--sidebar-sidebar` (aliased to `--color-sidebar`), `-foreground`, `-primary`, `-primary-foreground`, `-accent`, `-accent-foreground`, `-border`, `-ring`. Note: there is **no** `--sidebar` — the Figma path is `sidebar/sidebar`. |
| Chart tokens | `--chart-chart-1..5`, aliased to `--color-chart-1..5` |
| Brand/extra tokens | `--custom-brand-{orange,amber,green,blue,purple,red}`, `--agent-{orange,amber,purple,blue,green}-{light,dark}`, `--info/-foreground/-ring`, `--success/-80/-foreground/-ring`, `--warning/-foreground/-ring`, `--ring-focus`, `--scrim`, the `--opacity-*` overlay set, and the whole `--custom-*` family |
| Breakpoint | No `--breakpoint-*` override; `md` is stock 768px, mirrored in JS by `MOBILE_BREAKPOINT = 768` (`packages/ui/src/hooks/use-mobile.ts`) |

Two class names appear in primitives that resolve to **nothing** in this repo: `cn-font-heading` (`card.tsx` CardTitle, `empty.tsx` EmptyTitle) and `cn-toast` (`sonner.tsx`). Grepped `globals.css`, `shadcn/dist/tailwind.css` and every `.css` in `node_modules` — no definition. They are shadcn `base-lyra` registry leftovers, currently inert. Real heading font usage is the `font-heading` utility (`alert-dialog.tsx`, `drawer.tsx`, `create-agent-dialog.tsx`), which resolves to the same family as `font-sans`.

---

## 2. Typography

**Families.** One family for everything: **GT Standard L** (licensed, Grilli Type), self-hosted from `packages/ui/src/styles/fonts/`:

- `gt-standard-l-300.woff2` (300)
- `gt-standard-l-400.woff2` (400)
- `gt-standard-l-500.woff2` (500)
- `gt-standard-l-600.woff2` (600)
- `gt-standard-l-700.woff2` (700)
- `gt-standard-mono-vf.woff2` — **GT Standard Mono VF**, variable, `font-weight: 300 900` (the range is mandatory; the axis defaults to 900)

No italics shipped. All `font-display: swap`.

**Where loaded.** Purely via `@font-face` in `packages/ui/src/styles/globals.css` — **not** in `apps/web/index.html`, no `@import` from a CDN, no `next/font`. `index.html` has no font links at all (it carries only viewport, `color-scheme`, two media-gated `theme-color` metas and favicon links).

**Base size.** Stock Tailwind (`1rem`/16px root, no `--text-*` overrides). `@layer base` sets `html`/`body` to `font-sans`, `bg-background`, `text-foreground`. Most surfaces then declare their own size — `text-sm` is the de-facto body size inside cards/dialogs/tables (`Card` root has `text-sm`; `DialogContent`, `SheetContent`, `Table` all `text-sm`).

**Size distribution actually used in `apps/web/src/**/*.tsx`** (occurrence counts):

```
124  text-sm
 59  text-base
 40  text-xs
  8  text-lg
  6  text-4xl
  2  text-3xl
  2  text-2xl
  1  text-xs/relaxed
```

Font-weight distribution: `font-medium` 59, `font-mono` 7, `font-semibold` 3, `font-normal` 3, `font-heading` 2, `font-sans` 1. There is essentially **no `font-bold` in the product**.

**Heading conventions actually used** (all `<hN>` in `apps/web/src`):

| Level / context | Classes | File |
|---|---|---|
| Page `h1` (in-app) | `font-medium text-2xl text-foreground` | `apps/web/src/components/page/page-header.tsx` (`PageHeaderTitle`) |
| Page description | `text-base text-muted-foreground` | same file (`PageHeaderDescription`) |
| Pre-auth `h1` | `text-center text-4xl tracking-tight` (no weight → 400) | `apps/web/src/routes/login.tsx:261`, `signup.tsx:232`, `onboarding.tsx:497`, `forgot-password.tsx:72`, `reset-password.tsx:126` |
| Upgrade `h1` | `text-center font-medium text-4xl text-foreground tracking-tight` | `apps/web/src/routes/_auth/upgrade.tsx:103` |
| Home greeting `h1` | `flex flex-col items-center gap-2.5 text-center font-normal text-3xl tracking-tight` | `apps/web/src/components/home/home-greeting.tsx:68` |
| Settings section `h2` | `font-medium text-lg` | `apps/web/src/components/settings/settings-section.tsx:23` |
| Billing panel `h2` | `font-medium text-foreground text-lg` | `apps/web/src/components/settings/billing-panel.tsx:271` |
| Plan name `h2` | `font-medium text-2xl text-foreground tracking-tight` | `apps/web/src/components/billing/upgrade-plans.tsx:145` |
| Detail-page `h2` | `text-base text-muted-foreground` | `automation-detail.tsx:315,330`, `automation-triggers.tsx:223` |
| Card/dialog sub-`h3` | `font-medium text-base text-foreground tracking-tight` | `agent-config-dialog.tsx:221,268,343` |
| Small `h3` | `font-medium text-sm` / `font-semibold text-sm` | `app-picker-dialog.tsx:143`, `slack-bind-card.tsx:435` |
| `CardTitle` | `cn-font-heading font-medium text-base leading-snug` | `packages/ui/src/components/card.tsx:39` |
| `DialogTitle` | `font-medium text-sm` | `packages/ui/src/components/dialog.tsx:123` |
| `AlertDialogTitle` | `font-heading font-medium text-sm` | `packages/ui/src/components/alert-dialog.tsx:104` |
| `SheetTitle` | `font-medium text-foreground text-sm` | `packages/ui/src/components/sheet.tsx:107` |

Pattern to carry over: **headings are `font-medium` (500), rarely semibold; `tracking-tight` on the large ones; dialog/sheet titles are only `text-sm`.**

---

## 3. Icons

- **Library: Material Symbols**, `@material-symbols/svg-400@^0.47.0`, **weight 400, outlined style, Fill axis ON**.
- **Not** a runtime dependency — it is a `devDependency` of `packages/ui`. Icons are **generated as React components** into a single committed file: `packages/ui/src/components/icons.tsx` (644 lines), by `packages/ui/scripts/generate-icons.mjs` (`node scripts/generate-icons.mjs` from `packages/ui`).
- lucide-react was the predecessor; swapped under CAN-305.
- Closed set of **67 glyphs** listed in `NAMES` in the generator: `add, apartment, archive, arrow_back, arrow_downward, arrow_forward, arrow_upward, attach_file, bar_chart, bolt, calendar_today, chat_bubble, check, check_circle, chevron_left, chevron_right, close, content_copy, credit_card, dangerous, delete, description, edit, electrical_services, explore, graph_5, grid_view, group, history, image, info, keyboard_arrow_down, keyboard_arrow_up, keyboard_double_arrow_left, keyboard_double_arrow_right, language, logout, mail, menu, mic, more_horiz, notifications, open_in_new, pause, person_add, person_cancel, person_remove, play_arrow, power, progress_activity, refresh, remove, replay, schedule, search, send, settings, stop, store, swap_vert, timer, tune, unarchive, unfold_more, view_sidebar, warning, wifi_off`. Export naming is derived: `graph_5` → `Graph5Icon`, `add` → `AddIcon`.

**Default rendering** — the shared `MaterialSymbol` wrapper in `icons.tsx`:

```tsx
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 -960 960 960"
  width={24}
  height={24}
  fill="currentColor"
  {...(hasA11yProp(props) ? undefined : { "aria-hidden": true })}
  {...props}
>
```

So: **no stroke — these are filled paths on `currentColor`**, intrinsic 24×24, `aria-hidden` by default unless the caller passes any `aria-*` or `role`.

**Effective size conventions come from the consumers, not the icon:**

- Button base: `[&_svg:not([class*='size-'])]:size-4` (16px). `size="xs"` and `size="icon-xs"` drop it to `size-3` (12px).
- Badge: `[&>svg]:size-3!` (12px, forced).
- Sidebar menu button: `[&_svg]:size-4`.
- Alert / Item / Toggle / navigation: `size-4`.
- `EmptyMedia variant="icon"`: a `size-8` `rounded-lg bg-muted` box with a `size-4` glyph.
- `AlertDialogMedia`: `size-10 rounded-md bg-muted` box with `size-6` glyph.
- `Spinner` = `ProgressActivityIcon` with `size-4 animate-spin`, `role="status"`, `aria-label="Loading"` (`packages/ui/src/components/spinner.tsx`).
- Toast icons: `size-4` (`sonner.tsx`).

---

## 4. Primitives inventory — `packages/ui/src/components/`

### `components.json` (packages/ui) — verbatim

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-lyra",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@cando/ui/components",
    "utils": "@cando/ui/lib/utils",
    "hooks": "@cando/ui/hooks",
    "lib": "@cando/ui/lib",
    "ui": "@cando/ui/components"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

`apps/web/components.json` — same `style: "base-lyra"`, `baseColor: "neutral"`, `cssVariables: true`, but `tailwind.css: "../../packages/ui/src/styles/globals.css"` and app-local aliases:

```json
"aliases": {
  "components": "@/components",
  "utils": "@cando/ui/lib/utils",
  "ui": "@cando/ui/components",
  "lib": "@/lib",
  "hooks": "@/hooks"
}
```

### Full file list (77 `.tsx` under `packages/ui/src/components/`)

`accordion, alert-dialog, alert, attachment, avatar, badge, bloom-face-art, bloom-face, breadcrumb, bubble, button-group, button, calendar, card, carousel, chart, checkbox, collapsible, combobox, command, context-menu, data-table-filter-chip, data-table-pagination, data-table-toolbar, data-table, dialog, dot-sprite, drawer, dropdown-menu, empty, field, hover-card, icons, inline-edit, input-group, input-otp, input, item, kbd, label, marker, menubar, message-scroller, message, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle-group, toggle, tooltip`

Also: `packages/ui/src/hooks/use-mobile.ts`, `packages/ui/src/lib/utils.ts`, `packages/ui/src/tokens/{colour-literals,mode-pairs}.ts`, and scripts `agent-palette-oklch.mjs`, `check-design-tokens.mjs`, `check-token-utilities.mjs`, `generate-icons.mjs`, `mode-collection-oklch.mjs`.

### Not stock shadcn at all — cando-original components

| File | What it is |
|---|---|
| `icons.tsx` | Generated Material Symbols set (section 3) |
| `bloom-face.tsx` + `bloom-face-art.tsx` (2947 lines) | The agent avatar system. 36 named faces (`Payroll`, `Reception`, `Scheduling`, …, `Test & Tag`), each a hand-drawn SVG with baked hex fills. `BloomFace` renders `viewBox="0 0 48 48"`, default `size-12 shrink-0 overflow-hidden rounded-full`, `role="img"` only when a `label` is passed (else `presentation` + `aria-hidden`). Exports `BLOOM_FACE_HUE: Record<BloomFaceType, "orange"\|"amber"\|"purple"\|"blue"\|"green"\|"neutral">` so callers can pick the matching `--agent-*` token. **This is the one sanctioned exception to the no-hex rule.** |
| `dot-sprite.tsx` (203 lines) | Seeded identicon for automations — six hue families, each ground + two tones, 18 hex literals whitelisted in `COLOUR_EXCEPTIONS` |
| `marker.tsx` | Small meta/annotation line, `cva` variants `default \| separator \| border` |
| `bubble.tsx` | Chat bubble, 7 variants (`default, secondary, muted, tinted, outline, ghost, destructive`) + `bubbleReactionsVariants` (`side: top\|bottom`, `align: start\|end`) |
| `message.tsx`, `message-scroller.tsx` | Chat thread primitives |
| `attachment.tsx` | File attachment chip; `size: default\|sm\|xs`, `orientation: horizontal\|vertical`, `attachmentMediaVariants` `icon\|image`, `data-state=idle\|error\|done` |
| `inline-edit.tsx` | Click-to-edit label; exports `resolveInlineEditValue` (whitespace-only and unchanged-after-trim are both dropped) |
| `combobox.tsx` | 270 lines, built over `cmdk` + Popover |
| `data-table.tsx`, `data-table-toolbar.tsx`, `data-table-pagination.tsx`, `data-table-filter-chip.tsx` | The DS table family (below) |
| `spinner.tsx` | `ProgressActivityIcon` + `size-4 animate-spin` |
| `empty.tsx` | Present in recent shadcn, but customised (below) |

### Customisations worth diffing against stock shadcn

**`button.tsx`** — the single most-diverged primitive.

Base: 
```
group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-sm outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0
```
Key diffs vs stock: `rounded-lg` (not `rounded-md`), `ring-3` (not `ring-[3px]`/`ring-1`), `active:not-aria-[haspopup]:translate-y-px` (a physical press), and the custom bevel shadows.

Variants (6): 
- `default`: `hover:button-sheen bg-primary text-primary-foreground shadow-button hover:shadow-button-hover`
- `outline`: `border-input bg-custom-bg-input-30-trans-light hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground`
- `secondary`: `bg-secondary text-secondary-foreground shadow-button hover:shadow-button-hover aria-expanded:…`
- `ghost`: `hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground`
- `destructive`: `bg-destructive text-destructive-foreground shadow-button hover:shadow-button-hover focus-visible:border-destructive/40 …`
- `link`: `text-foreground underline-offset-4 hover:underline` (note: **foreground, not primary**)

Sizes (8, all smaller than stock): `default h-8 px-2.5`, `xs h-6 rounded-md px-2 text-xs` (icons drop to `size-3`), `sm h-7 rounded-md px-2.5 text-xs`, `lg h-9 px-2.5`, `icon size-8`, `icon-xs size-6 rounded-md`, `icon-sm size-7 rounded-md`, `icon-lg size-9`. Every non-icon size has `has-data-[icon=inline-end]:pr-*` / `has-data-[icon=inline-start]:pl-*` optical padding.

Base UI: takes `ButtonPrimitive.Props`, so callers use `render={<Link .../>}` and must pass `nativeButton={false}` when rendering an anchor.

**`badge.tsx`** — fixed `h-5`, `rounded-4xl` (uses the custom `--radius-4xl`), `[&>svg]:size-3!`. **Adds `success`, `ghost`, `link` variants** on top of stock's four. `success` is inverted per Figma: `bg-success-foreground text-success`. `destructive` is a tint: `bg-destructive/10 text-destructive`. Built with Base UI `useRender` + `mergeProps` (polymorphic `render` prop).

**`card.tsx`** — drives padding through a CSS var: `[--card-spacing:--spacing(4)]`, `data-[size=sm]:[--card-spacing:--spacing(3)]`, `size?: "default" | "sm"`. Root: `rounded-xl bg-card text-sm ring-1 ring-foreground/10` — **ring, not border**. `CardFooter` is a band: `border-t bg-muted/50 p-(--card-spacing)`.

**`input.tsx`** — `h-8` (stock is h-9), `rounded-lg`, `bg-custom-bg-input-30-trans-light`, `ring-3` focus. Base UI `InputPrimitive`.

**`dialog.tsx`** — overlay `bg-scrim … supports-backdrop-filter:backdrop-blur-xs` (token, not `bg-black/50`). Content: `rounded-xl bg-popover p-4 text-sm ring-1 ring-foreground/10 … max-h-svh overflow-y-auto … sm:max-w-sm`. `DialogFooter` is a **band pulled out of the padding**: `-mx-4 -mb-4 flex flex-col-reverse gap-2 border-t bg-muted/50 p-4 sm:flex-row sm:justify-end`, and takes `showCloseButton?: boolean`. Close button is `<Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">`. The overlay is rendered with `forceRender` so a nested dialog (new-agent sheet inside the mobile nav drawer) keeps its scrim.

**`alert-dialog.tsx`** — adds `size?: "default" | "sm"` on the content (`data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm`) and **adds an `AlertDialogMedia` slot** (`size-10 rounded-md bg-muted`, glyph `size-6`) that the header grid reflows around. `AlertDialogCancel` defaults to `variant="outline"`. Header is centred by default and left-aligns only at `sm` in `size=default`.

**`sheet.tsx`** — `bg-popover`, side-aware translate-in of `2.5rem`, `data-[side=left]:w-3/4 … sm:max-w-sm`, and a **custom `overlayClassName` prop** (the backdrop is a sibling `className` cannot reach). Close at `absolute top-3 right-3`, `variant="ghost" size="icon-sm"`.

**`sidebar.tsx`** (814 lines) — constants `SIDEBAR_COOKIE_NAME="sidebar_state"`, max-age 7 days, `SIDEBAR_WIDTH="16rem"`, `SIDEBAR_WIDTH_MOBILE="18rem"`, `SIDEBAR_WIDTH_ICON="3rem"`, shortcut `"b"` (⌘B). Cando additions:
- `enableKeyboardShortcut?: boolean` on `SidebarProvider` (default `true`) — settings mounts a provider with `false` so ⌘B can't flip the app shell's cookie.
- `mobileLeading?: ReactNode` on `Sidebar` — renders content *inside* the mobile sheet, left of the menu (this is how the agent rail lands inside the drawer).
- `useEffect` resetting `openMobile` when leaving mobile width.
- `sidebarMenuButtonVariants` sizes retuned to Figma: `default h-8 text-sm`, `sm h-7 text-xs`, `lg h-12 font-semibold text-sm` (stock had `text-xs` for default and lg).
- `className` is forwarded to the mobile sheet too.

**`empty.tsx`** — `EmptyMedia` gains `variant: "default" | "icon"`, where `icon` = `size-8 rounded-lg bg-muted [&_svg…]:size-4`. Root has `rounded-none border-dashed` (no border colour/width by default), `p-6 md:p-12`.

**`field.tsx`** — `fieldVariants` `orientation: vertical | horizontal | responsive`; `FieldLabel` has a checked-card treatment (`has-data-checked:border-primary/30 has-data-checked:bg-primary/5`, dark `/20` `/10`).

**`table.tsx`** — near-stock but `TableHead h-10` and `TableRow` adds `has-aria-expanded:bg-muted/50`. `TableCell`/`TableHead` are `whitespace-nowrap` by default.

**`data-table.tsx`** — `DataTable` adds `layout?: "default" | "grid"` (`table-auto` vs `table-fixed`) with `data-layout` on the element; `DataTableRow` pins `h-10` (the 40px rhythm); `DataTableSubHeader` is a banded full-span row (`h-10 bg-muted hover:bg-muted`, required `colSpan`).

**`sonner.tsx`** — themed off `next-themes`, custom icon set (all cando Material Symbols at `size-4`, loading = `ProgressActivityIcon animate-spin`), and CSS-var overrides:

```tsx
style={{
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "calc(var(--radius) + 8px)",
}}
toastOptions={{ classNames: { toast: "cn-toast" } }}
```

**`tabs.tsx`** — `tabsListVariants` adds a third `button` variant beyond `default` and `line`.

**`toggle.tsx`** — sizes `h-8/h-7/h-9` with `min-w-*`; adds `aria-pressed:bg-muted` alongside `data-[state=on]`.

**`item.tsx`** — `variant: default | outline | muted`, `size: default | sm | xs`; `itemMediaVariants: default | icon | image`.

**`input-group.tsx`** — `inputGroupAddonVariants` align `inline-start | inline-end | block-start | block-end`; `InputGroupButton` defaults to `variant="ghost" size="xs"`.

**`alert.tsx`** — only two variants (`default`, `destructive`), both on `bg-card` (destructive differs only in text colour), plus a `data-[slot=alert-action]` slot with `pr-18` reservation.

**Skeleton** is stock: `animate-pulse rounded-md bg-muted`.

**Notable absence:** there is **no `form.tsx`** and no `Form`/`FormField`/`FormMessage` primitive.

---

## 5. App shell and UX patterns in `apps/web`

### 5.1 Route layout and the two shells

`apps/web/src/routes/`:

```
__root.tsx                       ← no chrome; ThemeProvider + Toaster + devtools
_auth/route.tsx                  ← the session guard, no chrome
_auth/_main/route.tsx            ← pathless; renders <AppShell>  (agent rail + main sidebar)
_auth/settings/route.tsx         ← pathed; its own 260px sidebar, no rail
_auth/upgrade.tsx                ← guard, neither shell
_auth/link-channel.tsx
login.tsx / signup.tsx / onboarding.tsx / forgot-password.tsx /
reset-password.tsx / accept-invitation.$id.tsx   ← public
```

AGENTS.md states the rule directly: *"`_auth` holds the guard and no chrome; the shell is one level down. A screen with the agent rail and the main sidebar goes in `_auth/_main/` (pathless); the settings surface, which draws its own sidebar and no rail, goes in `_auth/settings/`."*

### 5.2 Authenticated shell — `apps/web/src/components/shell/app-shell.tsx`

```tsx
<SidebarProvider
  defaultOpen={defaultOpen}                       // read from the sidebar_state cookie
  style={{ "--sidebar-width": "16.25rem" } as React.CSSProperties}   // 260px, overriding the primitive's 16rem
>
  <MobileTopBarProvider>
    <SkipNav />                                   {/* first focusable element */}
    <AgentRail className="hidden md:flex" />      {/* 48px rail, desktop only */}
    <MainSidebar />                               {/* 260px */}
    <SidebarInset
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className="grid h-svh min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[1fr]"
    >
      <MobileTopBar agentFace={<MobileTopBarAgentFace />} />
      {children}
    </SidebarInset>
  </MobileTopBarProvider>
</SidebarProvider>
```

Geometry: **48 (rail) + 260 (sidebar) + 1132 (content) = 1440**, the design width.

**Agent rail** — `apps/web/src/components/shell/agent-rail.tsx`. 48px column. Top→bottom: cando mark (`<img className="h-6 dark:invert" />`), a `Separator` (`bg-sidebar-border data-horizontal:w-8`), one 32px `AgentSwitcherItem` disc per non-archived agent (each a `BloomFace className="size-7.5"` inside a `Tooltip side="right"`), then `AgentSwitcherAdd`. Footer: a gear `Link` and the account `DropdownMenu`. The shared footer control class:

```ts
const RAIL_CONTROL =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&>svg]:size-4";
```

Skeletons while pending: `<Skeleton className="size-8 shrink-0 rounded-full" />` ×3.

A **second instance of the rail is mounted inside the mobile sheet** via `MainSidebar`'s `mobileLeading={<AgentRail />}` — it must be inside the sheet or every tap lands on the modal backdrop.

**Main sidebar** — `apps/web/src/components/shell/main-sidebar.tsx`:

```tsx
<Sidebar
  collapsible="offcanvas"
  className="data-[mobile=true]:data-[side=left]:left-0 data-[mobile=true]:data-[side=left]:w-full data-[side=left]:left-12"
  mobileLeading={<AgentRail />}
>
  <SidebarHeader className="py-1.5"><SidebarNav /></SidebarHeader>
  <SidebarContent>
    <SidebarGroup className="px-4"><NewThreadButton /></SidebarGroup>
    <SidebarGroup><SidebarMenu><SidebarNavigation /></SidebarMenu></SidebarGroup>
    <SidebarGroup>
      <SidebarGroupLabel className="text-sidebar-foreground">Agent automations</SidebarGroupLabel>
      <AgentAutomations />
    </SidebarGroup>
    <SidebarGroup>
      <SidebarGroupLabel className="text-sidebar-foreground">Recents</SidebarGroupLabel>
      <RecentChats />
    </SidebarGroup>
  </SidebarContent>
  <SidebarRail />
</Sidebar>
```

`data-[side=left]:left-12` offsets it past the rail. `LIST_SIZE = 5` rows per list before "View all". Nav data lives in `apps/web/src/lib/main-sidebar-nav-items.ts` (`NAV_ITEMS`, `AUTOMATIONS_NAV_ITEM`, `AUTOMATION_SUB_ITEMS`, `settingsTarget(isMobile)`). Sub-menu open state is **derived from the route**, never stored. Sidebar closes on navigate below `md` via `router.subscribe("onBeforeNavigate", () => setOpenMobile(false))`.

Loading: `<SidebarMenuSkeleton />` ×3. Empty/error: `<p className="px-2 py-1 text-muted-foreground text-xs/relaxed">No threads yet.</p>`.

**Mobile top bar** — `apps/web/src/components/shell/mobile-top-bar.tsx`. `md:hidden`, `flex h-12 shrink-0 items-center justify-between gap-2 px-3 py-1.5`. A `<div>`, not `<header>` (it's inside `<main>`). Slots (`face`/`title`/`actions`) are filled via a React context and the `useMobileTopBar()` hook from whichever screen is mounted. Hamburger: `<SidebarTrigger aria-label="Open navigation" size="icon-lg" className="touch-manipulation"><MenuIcon /></SidebarTrigger>`.

### 5.3 Settings shell — `apps/web/src/routes/_auth/settings/route.tsx`

```tsx
<SidebarProvider defaultOpen={false} enableKeyboardShortcut={false}>
  <MobileTopBarProvider>
    <div className="flex h-svh w-full">
      <SkipNav />
      <SettingsMobileNav />                 {/* MainSidebar, only when isMobile */}
      <SettingsSidebar />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex min-w-0 flex-1 flex-col bg-background">
        <SettingsSectionTopBar />
        <MobileTopBar agentFace={<MobileTopBarAgentFace />} />
        <div className="min-h-0 flex-1 overflow-y-auto"><Outlet /></div>
      </main>
    </div>
  </MobileTopBarProvider>
</SidebarProvider>
```

`main` deliberately carries **no padding** — every gutter is inside `PageContainer`.

**`SettingsSidebar`** (`apps/web/src/components/settings/settings-sidebar.tsx`) is hand-rolled, not the `Sidebar` primitive:

```
nav: "hidden h-full w-65 shrink-0 flex-col overflow-y-auto border-sidebar-border border-r bg-sidebar text-sidebar-foreground md:flex"
"Back to app" link: "flex items-center gap-1.5 rounded-md px-1.5 py-2 text-muted-foreground text-sm transition-colors hover:text-sidebar-foreground"
group label: "flex h-8 items-center px-2 font-medium text-xs"
const ROW = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors"
active:   "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
inactive: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
```

Nav data: `apps/web/src/components/settings/settings-nav-items.ts` (`SETTINGS_NAV_GROUPS`). Below `md` the sidebar hides and `/settings` renders `settings-landing-list.tsx` instead.

**Settings content primitives** (`apps/web/src/components/settings/`):

- `SettingsSection`: `<section className="flex flex-col gap-3"><h2 className="font-medium text-lg">{heading}</h2>{children}</section>`
- `SettingsCard`: `overflow-hidden rounded-xl border border-foreground/10 bg-card`
- `SettingsCardContent`: `p-4`
- `SettingsRowGroup`: inset dividers via pseudo-elements — `[&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:border-border [&>*+*]:before:border-t`
- Row family in `settings-row.tsx`: `SettingsRow` (`flex items-center justify-between gap-4 px-4 py-3`, title `text-base` **regular weight**, description `text-muted-foreground text-sm`, `stacked` prop for mobile), `SettingsToggleRow` (wires `aria-labelledby` to the title automatically), `SettingsSelectRow` (`flex h-16 items-center justify-between gap-4 px-4`, control is 240px → `className="w-60"`), `SettingsFieldRow` (`flex flex-col items-start gap-3 p-4 md:h-16 md:flex-row md:items-center md:justify-between md:gap-4 md:px-4 md:py-0`), `SettingsButtonRow`, `SettingsEmptyRow`.
- `SettingsTextField`: an `Input className="w-60"` that commits on blur/Enter and abandons on Escape.

### 5.4 Page header / container / nav strip

**`apps/web/src/components/page/page-header.tsx`** — five parts:

```
PageHeader            "flex items-start justify-between gap-2.5"
PageHeaderContent     "flex min-w-0 flex-1 flex-col gap-1"
PageHeaderTitle  <h1> "font-medium text-2xl text-foreground"
PageHeaderDescription <p> "text-base text-muted-foreground"
PageHeaderActions     "flex shrink-0 items-center gap-2"
```

**`apps/web/src/components/page/page-container.tsx`** — the page column, `data-slot="page-container"`:

```tsx
const SIZES = {
  large:  "max-w-6xl",   // 1152
  medium: "max-w-4xl",   //  896
  small:  "max-w-2xl",   //  672
  xs:     "max-w-md px-4", // 448, 16px horizontal
  full:   "max-w-none",
};
className={cn("mx-auto flex w-full flex-col p-6", SIZES[size], className)}
```

24px padding on every side; `xs` overrides the horizontal to 16. Not `cva` — `class-variance-authority` is a `packages/ui` dep and `apps/web` does not carry it.

**`apps/web/src/components/page/page-nav.tsx`** — a 48px strip under the header:

```
PageNav  <nav>  "flex h-12 items-center justify-between gap-2.5 border-b px-6"
PageNavSubPageTitle <span> "flex items-center gap-3 font-medium text-base text-foreground"
```

`_main` call sites add their own `hidden … md:flex` (MobileTopBar replaces the strip below `md`); `upgrade.tsx` keeps it at all widths. `PageNavCollapsedSidebar` (`page-nav-collapsed-sidebar.tsx`) renders `<div className="flex h-8 w-14 items-center gap-2">` holding a `SidebarToggle className="size-8"` plus `<Separator orientation="vertical" className="h-6" />` — visible only when the sidebar is collapsed and not mobile.

### 5.5 Tables

Two layers. The primitive family (`data-table.tsx` + `table.tsx`), then per-screen tables in `apps/web/src/components/`.

Representative: `apps/web/src/components/connections/connections-table.tsx`.

```tsx
<DataTable layout="grid">            {/* table-fixed */}
  <TableHeader>
    <TableRow>
      <TableHead className="w-34 truncate md:w-100">Account</TableHead>
      <TableHead className="w-25 truncate md:w-55" aria-sort={ARIA_SORT[sort]}>
        <Button variant="link" className="h-5 px-0" onClick={onSortChange}>
          Last refreshed{sort === "none" ? <SwapVertIcon /> : sort === "desc" ? <ArrowDownwardIcon /> : <ArrowUpwardIcon />}
        </Button>
      </TableHead>
      <TableHead className="w-21.5 truncate md:w-55">Approved tools</TableHead>
      <TableHead className="w-9 md:w-8"><span className="sr-only">Actions</span></TableHead>
    </TableRow>
  </TableHeader>
  <TableBody className="[&_tr:last-child]:border-b">
    {isPending ? [0,1,2].map(i => (
       <DataTableRow key={i}><TableCell colSpan={4}><Skeleton className="h-5 w-full" /></TableCell></DataTableRow>
    )) : isError ? <BodyNote><RetryNotice … /></BodyNote>
      : groups.length === 0 ? <BodyNote>No apps connected yet. …</BodyNote>
      : groups.map(g => <AppBand … />)}
  </TableBody>
</DataTable>
```

Conventions: column widths as explicit `w-*` on `TableHead` under `layout="grid"`; distinct mobile/desktop widths (`w-34 md:w-100`); sortable header = `Button variant="link" className="h-5 px-0"` + directional icon + `aria-sort`; loading is skeleton rows, not a spinner; empty and error both render inside the `<tbody>` as a full-span note; row actions column is `sr-only`-labelled. Other examples: `apps/web/src/components/run/run-history-table.tsx`, `apps/web/src/components/settings/members-panel.tsx`.

### 5.6 Forms

**There is no form library in use.** `apps/web/package.json` lists `@hookform/resolvers ^5.9.1` and `@tanstack/react-form ^1.33.5`, but a repo-wide grep finds **zero imports of `react-hook-form` and zero imports of `@tanstack/react-form`** — both are unused deps.

Forms are plain `useState` + a native `<form onSubmit>` with `event.preventDefault()`, composed from the `field.tsx` primitives. `zod` is used, but for **route search-param validation** (`validateSearch`), not form schemas — see `apps/web/src/routes/login.tsx`, `signup.tsx`, `reset-password.tsx`, `forgot-password.tsx`, `_auth/link-channel.tsx`, `_auth/_main/automations.tsx`, `channels.slack.tsx`, `connections.callback.tsx`, `_auth/settings/billing.tsx`.

Canonical form shape — `apps/web/src/components/auth/sign-in-card.tsx`:

```tsx
<form onSubmit={handleSubmit} className="flex flex-col gap-6">
  <FieldGroup className="gap-4">
    <Field>
      <FieldLabel htmlFor="sign-in-email" className="leading-none">Email</FieldLabel>
      <Input id="sign-in-email" name="email" type="email" placeholder="m@example.com"
             autoComplete="email" required value={email} onChange={…} disabled={pending} />
    </Field>
    …
    {error && <FieldError>{error}</FieldError>}
  </FieldGroup>
  <Button type="submit" className="w-full" disabled={pending}>{submitLabel}</Button>
</form>
```

Errors are a single string in local state rendered by `FieldError`; `disabled={pending}` is the in-flight convention. Settings-style edits use a different model entirely: commit-on-blur/Enter via `SettingsTextField` / `InlineEdit`, no submit button. Mutations go through `useMutation(orpc.<proc>.mutationOptions({ onSuccess, onError }))`.

### 5.7 Dialogs, sheets, drawers

- **Dialog** for form-bearing modals: `apps/web/src/components/connections/disconnect-dialog.tsx`, `apps/web/src/components/settings/agent-config-dialog.tsx`, `apps/web/src/components/connections/app-picker-dialog.tsx`, `apps/web/src/components/agent/create-agent-dialog.tsx`.
- **AlertDialog** for pure confirmations: `apps/web/src/components/chat/chat-delete-dialog.tsx`, `apps/web/src/components/unsaved-changes-dialog.tsx`.
- **Sheet** is used by the sidebar primitive for the mobile drawer (via `mobileLeading`); `drawer.tsx` exists for bottom sheets.
- Open state is held by the **parent**, passed as `open` / `onOpenChange`; dialogs are mounted as siblings, not wrapped around triggers (see the comment in `agent-rail.tsx`). Widths are overridden per call site: `<DialogContent className="sm:max-w-md">`.

### 5.8 Confirmation and destructive actions

`apps/web/src/components/chat/chat-delete-dialog.tsx` is the reference AlertDialog:

```tsx
<AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
      <AlertDialogDescription>
        This deletes the thread and its messages for everyone with access to this agent, and cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
      <AlertDialogAction variant="destructive" disabled={deleting} onClick={onDelete}>
        {deleting ? "Deleting..." : "Delete"}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

`apps/web/src/components/connections/disconnect-dialog.tsx` is the Dialog variant, with an in-flight spinner swapped for the icon:

```tsx
<Button variant="destructive" disabled={remove.isPending} onClick={…}>
  {remove.isPending ? <ProgressActivityIcon className="animate-spin" /> : <DeleteIcon />}
  Disconnect
</Button>
```

Conventions: title is a question ending in `?`; description states the blast radius and irreversibility; Cancel is `variant="outline"` (AlertDialogCancel's default) and comes **first in DOM but visually last** (`flex-col-reverse … sm:flex-row sm:justify-end`); the destructive button's label changes to a present participle while pending; both buttons disable. Destructive menu items use `<DropdownMenuItem variant="destructive">` (see sign-out in `agent-rail.tsx`).

### 5.9 Empty states

`Empty` + `EmptyHeader` + `EmptyMedia variant="icon"` + `EmptyTitle` + `EmptyDescription`, then a flat `<div className="flex gap-2">` of actions. Reference: `apps/web/src/components/route-not-found.tsx` and `apps/web/src/components/route-error.tsx`, both `<Empty className="mx-auto h-full max-w-md px-4">`. Voice rule, quoted from `route-not-found.tsx`: *"a sentence-case title carrying no full stop, one sentence of description whose clause after the em dash is reassurance rather than instruction."* Other users: `ai.$chatId.tsx`, `connections.callback.tsx`, `accept-invitation.$id.tsx`, `reset-password.tsx`. Inline list-level empties are plain muted paragraphs (`<p className="px-2 py-1 text-muted-foreground text-xs/relaxed">`) or a `<BodyNote>` row inside a table.

### 5.10 Loading / skeletons

- Route-level: `defaultPendingComponent: () => <Loader />` in `apps/web/src/main.tsx`; `apps/web/src/components/loader.tsx` is `<div className="flex h-full items-center justify-center pt-8"><ProgressActivityIcon className="animate-spin" /></div>`.
- Component-level: `Skeleton` shaped to the thing it replaces — `size-8 shrink-0 rounded-full` for avatars, `h-4 w-24` for a name, `h-5 w-full` inside a table cell, `h-9 w-72`/`h-9 w-112` for the home greeting, `<SidebarMenuSkeleton />` for nav rows.
- The rule stated in `main-sidebar.tsx`: pending is its own state — never render the empty branch while a query is still pending.
- In-button spinners: `ProgressActivityIcon className="animate-spin"` or the `Spinner` primitive.

### 5.11 Toasts

**sonner**, mounted once: `<Toaster richColors />` in `apps/web/src/routes/__root.tsx`, wrapping the cando `Toaster` from `@cando/ui/components/sonner`.

Two usage layers:

1. **Ad hoc** from mutation handlers: `toast.success("Disconnected")`, `toast.error(error.message)`.
2. **Global query-error toast with a working Retry** — `apps/web/src/lib/query-error-retry.ts`, wired into the single `QueryCache` in `apps/web/src/utils/orpc.ts`:

```ts
toast.error(`Error: ${error.message}`, {
  id: query.queryHash,                 // replaces rather than stacks
  action: {
    label: "Retry",
    onClick: () => {
      if (query.state.fetchStatus === "fetching") return;
      void client.refetchQueries({ queryKey: query.queryKey, exact: true });
    },
  },
});
```
with `onSuccess` dismissing by the same id. `QueryClient` defaults: `staleTime: 10_000`, a custom `queryKeyHashFn` (`scopedQueryKeyHashFn`) folding user/org/agent into every key.

### 5.12 Login / signup / onboarding styling

Page frame, identical across `login.tsx`, `signup.tsx`, `onboarding.tsx`, `forgot-password.tsx`, `reset-password.tsx`:

```tsx
<div className="relative flex min-h-svh flex-col overflow-hidden">
  <AuthHeader />
  <main className="flex flex-1 flex-col items-center px-4 pt-9 md:px-6 md:pb-40">
    <h1 className="text-center text-4xl tracking-tight">Log in to Cando</h1>
    <SignInCard className="mt-9 md:mt-8" … />
  </main>
  <BloomFaceStrip />
</div>
```

- `apps/web/src/components/auth/auth-header.tsx`: `<header className="mt-4 flex h-9 shrink-0 items-center justify-center px-4 md:mt-6 md:justify-start md:px-8">` with `<img src={candoWordmark} alt="Cando" className="h-8 dark:invert" />`.
- `apps/web/src/components/auth/sign-in-card.tsx`: `<Card className="w-full max-w-md">` → `CardContent` → `<PageContainer size="xs">` → the form. Two-beat sign-in (email step, then password appears in the same card). "Or" divider is two `<Separator className="flex-1" />` around `<span className="text-muted-foreground text-sm">Or</span>` — deliberately **not** `FieldSeparator`, whose overlaid `bg-background` label would notch against the card in dark mode. Google button: `variant="outline" className="w-full"` with a `size-6` centred brand mark; Google's mark is deliberately **not** `dark:invert`-ed (brand terms), while the single-colour cando mark/wordmark are.
- `apps/web/src/components/auth/bloom-face-strip.tsx`: 11 art-directed `BloomFace`s, positions as inline styles (`left` as a % of a 1440 design width, fixed `top`/`size` in px), container `pointer-events-none absolute right-0 bottom-0 h-35 w-360 select-none md:inset-x-0 md:w-auto`.
- Onboarding (`apps/web/src/components/onboarding/onboarding-card.tsx`): `<Card className="w-full max-w-md">` wrapping a `<form className="flex flex-col">`; header `<CardHeader className="gap-1.5 pt-8 pb-6 text-center">` with `<CardTitle role="heading" aria-level={2} className="text-lg leading-7">` and `<CardDescription className="mx-auto max-w-88 text-base">`; body and footer each in their own `CardContent`, body wrapped in `<PageContainer size="xs">`. Draft state lives above the card so Back preserves typing.

### 5.13 Other cross-cutting details

- `apps/web/src/components/skip-nav.tsx` exports `MAIN_CONTENT_ID` and `SkipNav`; both shells mount `SkipNav` first and give the main region `tabIndex={-1}`.
- `apps/web/src/index.css` is just `@import "@cando/ui/globals.css";` + `@source "../node_modules/streamdown/dist/*.js";` + one rule for the Tiptap composer placeholder (`.tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--muted-foreground); float: left; height: 0; pointer-events: none; }`).
- Router: `defaultPreload: "intent"`, `defaultPreloadStaleTime: 0`, `scrollRestoration: true`, `defaultNotFoundComponent: RouteNotFound` (set on the router, not the root route).
- Copy convention (AGENTS.md/CAN-137): **sentence case** for every action label ("Sign out", not "Sign Out").

---

## 6. Design references — ADR 0008 and the CI gate

### ADR 0008 — `docs/adr/0008-figma-is-the-source-of-truth.md` (status: accepted)

**Core rule.** The frontend is built to match a Figma file, not to interpret it. Where design and code disagree, the design wins and the fix is made **in Figma first**, never patched in code against a stale design. Agents do not write to Figma; a gap is raised to a human.

**The two Figma file keys (recorded in the ADR and echoed in AGENTS.md):**

| Purpose | File key |
|---|---|
| **Product screens** | `zJnMf9I7vLTOY3OrK77kRa` |
| **Design system** (components + variables; what `cando-import-variables` syncs from) | `C8akmASa3NHsyFOlU3rW8I` |

The keys are written down because confusing them is misleading rather than loud: the design-system key resolves, subscribes and answers, so nothing looks broken — a product node id just comes back not-found and `get_design_context` reports nothing selected. CAN-110 lost a whole implementation pass diagnosing that as a broken MCP server.

**Two tooling cautions.** `get_metadata` with **no** `nodeId` under-reports pages badly — against the product file it returns one page (`0:1 🖼 Cover`) when the file has seven, and the page holding every screen is absent from the listing. `get_metadata` *with* a `nodeId` is reliable. To enumerate a file, read `figma.root.children` via `use_figma`. Separately: component `description` text in the design system is inherited and goes stale — **follow the variant, not the description**.

**Viewports.** Two exact widths, both on one page — `🖥 Cando Build Screens - Mobile`, node `2056:825179`, in the product file:

- **1440×1024** (desktop; e.g. `Home` = `2056:825181`)
- **390×844** (mobile; built CAN-352…CAN-364, CAN-377)

The page name is "a trap, not a description". `3:2` (`🖥 Cando Build Screens`) is the **superseded** page. **391–1439 is explicitly silent** — no tablet frame at any width in that band, so it is written best-effort and must not be described as verified. The cutover is a CSS one, not a frame one: `MOBILE_BREAKPOINT` in `packages/ui/src/hooks/use-mobile.ts` is pinned to Tailwind's stock `md` (768px) so JS and CSS cannot drift.

**Colour rule (the important one for porting).** The Figma frames are **light only**. Dark exists as a Figma variable mode the team has chosen not to flip, so **dark mode ships derived from the tokens in `globals.css` and is never verified per screen.** Therefore: *"a hardcoded colour or an arbitrary value is invisible in light and broken in dark, with no check that would catch it. The no-hex, no-arbitrary-values rule is not a style preference here — it is the entire mechanism by which dark mode is correct."* The ADR also notes the ten `--agent-*` tokens have no `.dark` counterpart, so agent identity colours are identical in both modes.

**Consequences.** A structural gap (a screen or component that exists nowhere in the design) **blocks** its slice. A cosmetic gap does not — it becomes a ticket and code proceeds on agreed intent. A deliberate deviation is allowed and must be recorded in the PR that makes it. Each screen's PR carries a screenshot of the running route beside `get_screenshot` of the Figma node plus a written delta list; where no frame exists at the width being built, the PR marks the screen *"extrapolated — no frame"*.

**Visual regression.** `apps/e2e` (CAN-350, widened CAN-365) boots a built `apps/web` + real `apps/server` + the advisor console against a dedicated `cando_vrt` Postgres, signs in fixture users, and diffs every screen against `apps/e2e/tests/*-snapshots/`. Two Playwright projects in `apps/e2e/playwright.config.ts`:

```ts
projects: [
  { name: "chromium", testDir: "./tests", testIgnore: ["**/mobile/**"],
    use: { browserName: "chromium", viewport: { width: 1440, height: 1024 } } },
  { name: "mobile", testDir: "./tests/mobile",
    use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
]
```

Two platform baseline sets are committed per width (`-chromium-darwin.png` / `-chromium-linux.png`) because macOS and the Linux runner rasterise text differently. `pnpm run vrt` / `pnpm run vrt:update`; CI job named **Visual Regression**. Determinism rests on `page.clock.setFixedTime` and serving production builds (`vite preview`) so devtools badges never enter a baseline. The mechanical check **does not replace** the hand-made Figma comparison — "a pixel-identical screenshot can still be the wrong screenshot."

### The check-colours script — what it enforces and where it lives

**Entry point:** `packages/ui/scripts/check-design-tokens.mjs`. Run as `pnpm run check-colours` (root `package.json`: `node packages/ui/scripts/check-design-tokens.mjs`) or `pnpm --filter @cando/ui run check-colours`. Requires Node ≥22.18 for native type-stripping; CI pins `node-version: 24`.

**Logic lives in typechecked, unit-tested modules:** `packages/ui/src/tokens/colour-literals.ts` and `packages/ui/src/tokens/mode-pairs.ts` (with `.test.ts` siblings). The `.mjs` is only file-walking and the exit code.

**Scanned:** `packages/ui/src`, `apps/web/src`, `apps/advisor/src` (all `.ts`/`.tsx`), skipping `*.test.*`, `routeTree.gen.ts`, `node_modules`, `dist`, and `packages/ui/src/tokens/`.

**Three failure classes:**

- **Rule A — colour literals in components.** Three kinds: `palette` (a Tailwind default-palette utility like `bg-black/10`, `text-red-500`, across the namespaces `bg|text|border|ring|inset-ring|divide|outline|fill|stroke|shadow|inset-shadow|drop-shadow|from|via|to|caret|accent|decoration|placeholder`), `hex` (`#fff`/`#0F0C0A`/8-digit, including inside Tailwind arbitrary values where `_` replaces spaces), and `function` (`rgb()`, `oklch()`, `color-mix()` containing no `var(--…)`). `transparent`/`current`/`inherit` are deliberately excluded.
- **Rule A′ — colour literals inside `@theme` in `globals.css`**, where a mode is impossible. Error text: *"Declare the value in :root and .dark, and leave the @theme entry holding a var()."*
- **Rule B — a base token identical across modes while its derived family flips.** Parses `:root`/`.dark` pairs from `globals.css`. This is the shape of the CAN-130 `--destructive` bug.
- Plus: **stale exceptions** (an entry in `COLOUR_EXCEPTIONS` that matches nothing) fail too — *"a stale exception silently covers the next literal at that path."*

**Sanctioned exceptions** are a central, auditable list — `COLOUR_EXCEPTIONS` in `packages/ui/src/tokens/colour-literals.ts` — never inline ignore comments. Currently four: `bloom-face-art.tsx` (whole file, 365 hex literals of generated Figma artwork), `dot-sprite.tsx` (18 named literals), `slider.tsx` (`bg-white`, latent — component has no importers), and `components/theme-provider.tsx` (`#ffffff`, `#0f0c0a` — `<meta name="theme-color">` cannot take a `var()`; suffix-matched so it covers both SPAs).

**Sibling check:** `packages/ui/scripts/check-token-utilities.mjs` (`pnpm run check-tokens`) — asserts every design-token utility referenced in `packages/ui/src/components` and `apps/web/src` (`.ts` **and** `.tsx`) actually **compiles** into `apps/web/dist/assets/*.css`. It requires a build first. It exists because Tailwind emits nothing for an unknown utility — that's how `bg-switch-off-thumb` shipped a transparent switch knob. It is explicitly non-overlapping with `check-colours`: all five CAN-179 findings passed it.

**CI wiring** — `.github/workflows/ci.yml`:
- step *"Check for hardcoded colours and mode-orphaned tokens"* → `pnpm run check-colours`, failing with `::error::a colour is hardcoded, or a base token was left behind by its family … ADR 0008 makes token discipline the whole mechanism by which dark mode is correct, and dark is never verified per screen.`
- step *"Check design-token utilities against the built CSS"* → `pnpm run check-tokens`.
- job *"Visual Regression"*.

### Other UI-adjacent ADRs

- **`docs/adr/0017-sign-in-and-sign-up-are-two-doors.md`** (accepted) — `/login` and `/signup` are two public routes drawn from the same card. Frames `2056:825357`/`2056:825363` and `2424:54446`/`2424:54956` in the product file. Supersedes ADR 0007's closing note. A sign-in can no longer create an account; the ~350-line `email-door.ts` arbitration was deleted.
- **`docs/adr/0028-google-is-the-only-social-provider.md`** — Apple was drawn beside Google in the frames and dropped for launch; `sign-in-card.tsx` keeps the `gap-2` wrapper so a second provider slots back in.
- No other ADR under `docs/adr/` is about UI. The full list is ADRs 0001–0031 (see section listing earlier); the rest are backend/domain.

---

## 7. Dark mode

**Mechanism:** `next-themes` (`^0.4.6`, catalog), wrapped by `apps/web/src/components/theme-provider.tsx`.

Mounted in `apps/web/src/routes/__root.tsx`:

```tsx
<ThemeProvider
  attribute="class"
  defaultTheme="system"
  disableTransitionOnChange
  storageKey="vite-ui-theme"
>
  <Outlet />
  <Toaster richColors />
</ThemeProvider>
```

- Applied as a **class** on `<html>` (`.dark`), matched by `@custom-variant dark (&:is(.dark *))` in globals.css.
- Stored in `localStorage` under key **`vite-ui-theme`**.
- Default is **`"system"`** (CAN-291 — a fresh account follows the OS, it used to land in dark).

**Toggle UI:** there is no standalone theme button. It lives in the account dropdown at the foot of the agent rail — `apps/web/src/components/shell/agent-rail.tsx`, `RailUser`:

```tsx
<DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(value) => setTheme(value)}>
  <DropdownMenuLabel className="text-muted-foreground text-xs">Theme</DropdownMenuLabel>
  <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
  <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
  <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
</DropdownMenuRadioGroup>
```

(The label must sit **inside** the radio group — `DropdownMenuLabel` is Base UI's `Menu.GroupLabel` and throws without a `Menu.Group`/`Menu.RadioGroup` ancestor.) A second copy exists as an Interface theme `SettingsFieldRow` on `/settings/general`.

**Browser-chrome colour.** `apps/web/index.html` carries:

```html
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0c0a" />
```

and `ThemeColorMeta` inside `theme-provider.tsx` rewrites **every** matching meta on `useLayoutEffect` from `resolvedTheme`, using `THEME_COLOR = { light: "#ffffff", dark: "#0f0c0a" }` — the sRGB conversions of the two `--background` tokens, and a sanctioned `COLOUR_EXCEPTIONS` entry because the attribute cannot hold a `var()`.

**Flat artwork** (cando mark, wordmark) is single-colour near-black with a baked `#0F0C0A` fill and gets `dark:invert`. The multicoloured Google mark is deliberately exempt.

---

## 8. `cando-import-variables` skill — Figma variables → CSS variables

Files: `.agents/skills/cando-import-variables/SKILL.md` plus `references/{token-sources,token-mapping,managed-region,figma-collections}.md`. Not vendored — it is one of three skills the repo owns (with `backend-architecture` and `cando-generate-code`), so it is absent from `skills-lock.json`.

### Workflow (SKILL.md)

1. Resolve the token source in priority order: UI Rules MCP (future) → Figma MCP variables → a local `globals.css`/tokens file. Stop at the first available; tell the user which.
2. Extract both modes.
3. Map to shadcn token names. **Generate the block from the resolved source with a script — do not hand-curate.** "Curating by hand is how an import writes a plausible-looking subset and drops the rest silently."
4. Merge into `globals.css` **only inside the managed region**.
5. Verify: both blocks present, sentinels intact, **token count out == token count in** minus deliberate exclusions. Then build and run `pnpm --filter @cando/ui run check-tokens`.

### Non-negotiables (quoted)

- Never clobber content outside the managed region.
- Write every colour token the source defines, not just the canonical shadcn set.
- Name tokens after the source variable's full path so they round-trip.
- Keep the shadcn token set complete: every `:root` token has a `.dark` counterpart.
- Do not require a UI Rules account; fall through cleanly when it is absent.
- Exclude the kit's icon `styles` collection.

### Figma collection structure (`references/figma-collections.md`)

Three collections in the design-system file:

| Collection | Modes | Contains | Import? |
|---|---|---|---|
| **Tailwind** | one | stock Tailwind palette/scales | **no** |
| **Mode** | Light, Dark | the semantic layer components bind to | **yes, all of it** |
| **Style** | one | brand ramps + per-component tokens | selectively |

Namespaces inside `Mode`: unprefixed shadcn core; **`custom/*`** (pre-composed alphas and mode-dependent surfaces — import all, several cannot be expressed as an opacity modifier because *the relationship itself changes between modes*, e.g. `custom/bg-input-30-trans-light` is opaque white in light but `foreground/4%` in dark); `sidebar/*` and `chart/*` (folders, flatten `/`→`-`); `opacity-*` (scrim overlays, white in light / black in dark).

**Read it programmatically, not via `get_variable_defs`** (which resolves one node, one mode). Walk `getLocalVariableCollectionsAsync()` and resolve each variable's `valuesByMode` for both mode ids in one pass, following `VARIABLE_ALIAS` chains to concrete values.

**Out of scope / excluded:** `icon-library/*`, `spacing/*`, `width/*`, `height/*`, `ring-width/*`, `border-width/*`, `text/*`, `font/*`, and `radius/*` beyond the base. `Style`'s `component/*` namespace (`component/button/size-default/radius`, `component/sidebar/menu-button/py`) belongs to `cando-generate-code`, not here.

### Naming rule (`references/token-mapping.md`)

> Name each custom property after the **source variable's full path**, with `/` becoming `-`, so `custom/bg-input-30` is `--custom-bg-input-30`. … a token in the code names exactly one variable in the design file and vice versa, so a fix in either place ports to the other without a translation table.

Two named hazards:
- Shortening for prettier utilities costs the round-trip (`--custom-bg-input-30` → the ugly `bg-custom-bg-input-30`; trimming to `--input-30` reads better and breaks the mapping). Keep the path.
- Paths that collide with shadcn vocabulary: `sidebar/sidebar` → `--sidebar-sidebar`, `chart/chart-N` → `--chart-chart-N`, so `bg-sidebar` and `fill-chart-1` would resolve to nothing. **Keep the Figma path and add a `@theme` alias** — exactly what globals.css does:

```css
--color-sidebar: var(--sidebar-sidebar);
--color-chart-1: var(--chart-chart-1);
```

**Radius:** only the base `--radius` is in scope; `--radius-sm/md/lg/…` are computed in `@theme` and must not be emitted per-mode. **Extended tokens** (`--font-*`, `--tracking-normal`, `--spacing`, `--shadow-*`) are opt-in by presence; the doc notes the cando kit expresses spacing/text through a build-time `--sc-*` layer, so a Figma-sourced import usually carries **colours + radius only**. Value format: match the file's existing convention first (this file is OKLCH throughout), else default to OKLCH.

**"The source is not always right."** Before writing, scan for a token aliasing a palette nothing else uses, a dark value that doesn't invert relative to its light counterpart, and a pair whose foreground fails contrast. Prefer the source; depart only when provably broken, and name the token and reason in the report. Values that are merely odd import as-is with a note — and globals.css duly carries `--opacity-30: oklch(1 0 0 / 70%)` and `--custom-bg-primary-5` at 10% in dark.

### Managed region contract (`references/managed-region.md`)

Sentinels, exactly as they appear in globals.css lines 128 and 349:

```css
/* cando:tokens:start. Managed by cando-import-variables. Edit source tokens, not this block. */
:root { … }
.dark { … }
/* cando:tokens:end */
```

Rules: replace **only** between the sentinels; preserve the sentinel lines exactly; on first run convert the existing `:root`/`.dark` in place rather than prepending a duplicate; never move or rewrite `@theme`/`@theme inline`, `@import`s, `@plugin`s, `@custom-variant`s, or the computed `--radius-*`/`--color-*` mappings; preserve project tokens the source omits; do not migrate value formats unnecessarily; show a diff for first-run or large edits.

---

## Quick porting checklist for a Vite + React + TanStack Router + shadcn console

1. Copy `packages/ui/src/styles/globals.css` verbatim (or vendor `@cando/ui`). It needs `tailwindcss@4`, `tw-animate-css@^1.4`, and `shadcn@^4.19` installed so `@import "shadcn/tailwind.css"` resolves — without it, `data-open:`/`data-horizontal:`/`no-scrollbar` compile to nothing.
2. Ship the six `.woff2` files alongside it at `./fonts/` relative to the CSS, or rewrite the `@font-face` `src` URLs.
3. Set `components.json` to `style: "base-lyra"`, `baseColor: "neutral"`, `cssVariables: true`, `tailwind.config: ""`.
4. Use Base UI (`@base-ui/react`) primitives with the `render={<X />}` polymorphism, not Radix `asChild`. Remember `nativeButton={false}` when a `Button` renders an anchor.
5. Adopt `next-themes` with `attribute="class"`, `defaultTheme="system"`, `storageKey="vite-ui-theme"`, plus the `theme-color` meta sync.
6. Adopt `sonner` with the cando `Toaster` overrides and the `QueryCache` error/retry toast pattern.
7. Copy the two guard scripts (`packages/ui/scripts/check-design-tokens.mjs` + `src/tokens/*.ts`, and `check-token-utilities.mjs`) and wire them into CI — they are the only reason dark mode is correct.
8. Do **not** add a form library to match; cando uses plain `useState` forms over the `field.tsx` primitives, and zod only for route search params.