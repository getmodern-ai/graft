# Survey: the Graft console before the Cando design-system alignment (read-only, 2026-09-11)

Written by an Explore agent from the working tree of the Graft checkout at main d68a1d3. Facts with file paths; no opinions.

## Graft console (`apps/web`): current state

Repo: the Graft checkout, `main` at `80f3fa6`. Everything below is read from the working tree.

Vocabulary from `CONTEXT.md` (relevant nouns): **Console** = "the web app where a person enters a secret, completes an OAuth consent, answers an approval, and sees each agent's working set"; **Handoff** = a URL a meta-tool returns so the person does the next step in the console; **Pending action / Approval / Working set / Scope / Connection / Agent / Tool** are the domain nouns the screens are named after. The authoritative prose about the console is `AGENTS.md` § "The console" (lines ~238–290) and `docs/adr/0006-the-console-is-the-channel-to-the-human.md`.

---

## 1. Stack

**Package**: `@graft/web`, private, `type: module`. `apps/web/package.json`

Scripts:
```
dev          vite dev
build        vite build
preview      vite preview
check-types  vite build && tsc -p tsconfig.json
test         vitest run
test:watch   vitest
```
`check-types` deliberately runs `vite build` first so a bundle that pulls `node:crypto`/drizzle in fails CI as a type error (documented in `apps/web/tsconfig.json` and `src/lib/connection-form.ts`).

**Versions** — all deps are `catalog:`, resolved in `pnpm-workspace.yaml` (lines 55–81, with a comment saying these are "the versions Cando's web app runs (ADR 0011)"):

| dep | version |
|---|---|
| react / react-dom | `^19.2.8` |
| vite | `^8.2.2` |
| @vitejs/plugin-react | `^6.1.1` |
| tailwindcss / @tailwindcss/vite | `^4.3.3` |
| tw-animate-css | `^1.4.0` |
| @tanstack/react-router | `^1.170.33` |
| @tanstack/router-plugin | `^1.168.36` |
| @tanstack/react-query | `^5.102.8` |
| @base-ui/react | `^1.8.0` |
| class-variance-authority | `^0.7.1` |
| clsx | `^2.1.1` |
| tailwind-merge | `^3.6.0` |
| lucide-react | `^1.43.0` |
| sonner | `^2.0.8` |
| better-auth | `1.7.2` (exact) |
| typescript | `^7` |
| vitest | `^4.1.11` |

Workspace deps: runtime `@graft/core`, `@graft/proxy`; dev/type-only `@graft/config`, `@graft/db`, `@graft/mcp`, `@graft/server`.

**Tailwind v4, no config file.** There is no `tailwind.config.*` and no `postcss.config.*` anywhere in the repo (verified by `find`). Tailwind is wired purely through the Vite plugin `@tailwindcss/vite` in `apps/web/vite.config.ts`, and tokens live in `@theme inline` inside `src/index.css`. So: **`@theme inline`, not `tailwind.config`** — the same shape Cando uses.

**Vite config** (`apps/web/vite.config.ts`, verbatim body):
```ts
const server = process.env.GRAFT_SERVER_URL ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 3001,
    proxy: {
      "/api": { target: server, changeOrigin: true },
      "/mcp": { target: server, changeOrigin: true },
    },
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
});
```
Dev proxy: `:3001` serves the SPA, `/api` and `/mcp` proxy to `GRAFT_SERVER_URL` (default `http://localhost:3000`). Same-origin on purpose so the Better Auth session cookie never crosses an origin. `resolve.tsconfigPaths: true` (Vite 8) is what resolves the `@/*` alias — there is no `vite-tsconfig-paths` plugin.

**`components.json`** (`apps/web/components.json`), verbatim:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-lyra",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```
Notes: `style` is **`base-lyra`** — a Base-UI-backed shadcn style, not the Radix `new-york`/`default` styles. `menuColor`/`menuAccent` are style-specific extra keys. `aliases.hooks` points at `@/hooks`, which **does not exist** (no `src/hooks` directory). `tailwind.config` is empty string (v4 mode).

**Where components live**: `apps/web/src/components/` — primitives in `src/components/ui/`, feature components in `src/components/{agent,auth,connection,pending,settings,shell}/` plus five loose files at `src/components/`. There is deliberately **no `packages/ui`** (AGENTS.md: "one SPA does not warrant a second workspace"). Regeneration command per AGENTS.md: `npx shadcn@latest add <name> -c apps/web` — and a warning that the CLI writes `from "cn"` for the utils alias, which must be hand-fixed to `@/lib/utils`.

**Production serving**: `apps/server/src/console.ts` — `createConsoleApp({ dir, exclude })`, a Hono sub-app mounted **last** by `apps/server/src/app.ts` (line 126) after the proxy, MCP and API, with `exclude: [API_MOUNT_PATH, MCP_MOUNT_PATH]`. Static files first via `@hono/node-server/serve-static`, then an SPA fallback that only answers `GET`s whose `accept` includes `text/html` or `*/*` (so a missing asset is a 404, not HTML). If `index.html` is absent under the directory the server still boots and every console path answers a JSON 404:
```
{ error: "console_not_built",
  message: "The console's build is not at <dir> — run `pnpm --filter @graft/web build`, or point GRAFT_CONSOLE_DIR at a directory that holds one" }
```
`GRAFT_CONSOLE_DIR` is defined in `packages/env/src/schema.ts:284` — a non-empty string, default `"../web/dist"`, relative to the server's cwd. Bound at `apps/server/src/index.ts:294`; the boot line at `index.ts:332` prints `console served from <dir>` or `console not built at <dir> (console paths answer 404)`.

`GRAFT_CONSOLE_URL` is a **different** setting (`packages/env/src/schema.ts:432/753`): the base of every handoff URL. In development it is the Vite origin (`http://localhost:3001`); in compose it is `${GRAFT_PUBLIC_URL:-http://localhost:3000}` (`docker-compose.yml:59`). `GRAFT_CORS_ORIGIN` remains only for a console served from a different origin.

The Docker image (`apps/server/Dockerfile`) runs the console's `vite build` in its `build` stage; server + proxy + MCP + console are one container.

---

## 2. Tokens

`apps/web/src/index.css` — the whole file, verbatim:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

/*
  The console's tokens: shadcn's neutral base, both modes, in the `@theme inline` shape the CLI
  writes for a Vite project. Graft has one SPA and no design file behind it yet, so these are the
  library's defaults and not Cando's imported Figma variables (`AGENTS.md`, "The console"); a
  `packages/ui` and a token import arrive if a second app or a design system ever does.
*/
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --success: oklch(0.448 0.1083 151.33);
  --success-foreground: oklch(0.972 0.0368 159.02);
  --warning: oklch(0.52 0.1047 73);
  --warning-foreground: oklch(0.99 0.0068 67.75);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --success: oklch(0.627 0.1699 149.21);
  --success-foreground: oklch(0.247 0.0516 157.94);
  --warning: oklch(0.846 0.1202 73.24);
  --warning-foreground: oklch(0.32 0.0643 73.96);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

Observations for the alignment plan:

- Stock shadcn neutral base, both modes, plus **two extra token pairs Cando-style already: `--success`/`--success-foreground` and `--warning`/`--warning-foreground`** (in `:root`, `.dark`, and `@theme inline`). No component in the app currently uses them — `grep` for `success`/`warning` classes turns up nothing outside the CSS.
- `--radius: 0.625rem` is declared and mapped to `--radius-{sm,md,lg,xl}`, **but the `base-lyra` primitives hard-code `rounded-none`** — 20 occurrences inside `src/components/ui/`, 21 total counting one feature file. Feature code meanwhile uses `rounded-md` (10) and `rounded-lg` (5) on ad-hoc wrappers (`Empty className="rounded-lg border"`, `<pre className="rounded-md border bg-muted/50 …">`). So the radius token is effectively dead in the primitives and live only in hand-written wrappers. This is the single biggest visual inconsistency to fix when moving to Cando radii.
- **No shadow tokens and essentially no shadows**: one `shadow-xs` in the whole app (the hand-rolled `<select>` in `src/components/settings/model-key-card.tsx`). The Card primitive uses `ring-1 ring-foreground/10` instead of a border/shadow; the Dialog popup likewise (`ring-1 ring-foreground/10`, backdrop `bg-black/10` + `backdrop-blur-xs`).
- **Fonts: none loaded at all.** `apps/web/index.html` (verbatim):
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Graft</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
No `<link>` to Google Fonts, no `@font-face`, no `@import` of a font, no font package in `package.json`, and no `--font-sans`/`--font-mono` in `@theme`. The app therefore runs on Tailwind v4's default `font-sans`/`font-mono` stacks. Adding Inter is a clean, unopposed change.
- **Dark mode is defined but never activated.** `@custom-variant dark (&:is(.dark *))` and a full `.dark` block exist, and eight primitives carry `dark:` classes, but nothing in the app ever adds the `.dark` class — no `documentElement.classList` call, no theme provider, no theme toggle. `index.html` declares `<meta name="color-scheme" content="light dark">`, which only affects UA-rendered controls.
- **Icon library: `lucide-react` `^1.43.0`**, used directly (no wrapper module). Icons in use: `BotIcon`, `InboxIcon`, `PlugIcon`, `SettingsIcon`, `LogOutIcon`, `PlusIcon`, `ArrowLeftIcon`, `RefreshCwIcon`, `TriangleAlertIcon`, `CompassIcon`, `ShieldAlertIcon`, `KeyRoundIcon`, `CopyIcon`, `CheckIcon`, `GlobeIcon`, `ExternalLinkIcon`, `ChevronDownIcon`, `ChevronUpIcon`, `XIcon`, `Loader2Icon`. No Material Symbols.
- `tw-animate-css` is imported for the `data-open:animate-in` / `data-closed:animate-out` classes the dialog uses.

---

## 3. Primitives inventory

`apps/web/src/components/ui/` — 16 files, 952 LOC, **all built on `@base-ui/react`, not Radix**. shadcn `base-lyra` style characteristics throughout: `rounded-none`, `text-xs` as the default type size, compact heights (`h-8` inputs/buttons), `ring-1` instead of shadows, `data-slot` attributes everywhere, `useRender`/`mergeProps` for polymorphism instead of Radix `asChild`.

| file | LOC | primitive source | notable shape / deviations from classic shadcn |
|---|---|---|---|
| `alert.tsx` | 75 | plain div | variants `default` \| `destructive` only. Exports an extra **`AlertAction`** slot (absolutely positioned top-right). `text-xs`, `rounded-none`, `bg-card`. |
| `badge.tsx` | 48 | `useRender` + `mergeProps` | 6 variants: `default`, `secondary`, `destructive`, `outline`, **`ghost`**, **`link`**. `h-5`, `rounded-none`, `text-xs`, forces `[&>svg]:size-3!`. Destructive is tinted (`bg-destructive/10 text-destructive`), not solid. |
| `button.tsx` | 55 | `@base-ui/react/button` | 6 variants (`default`, `outline`, `secondary`, `ghost`, `destructive`, `link`); 8 sizes: `default`(h-8), `xs`(h-6), `sm`(h-7), `lg`(h-9), `icon`(size-8), `icon-xs`, `icon-sm`, `icon-lg`. `rounded-none`, `text-xs`, `active:not-aria-[haspopup]:translate-y-px` press effect. **`destructive` is tinted** (`bg-destructive/10 text-destructive`), not the solid red of stock shadcn. Polymorphism via Base UI `render` + `nativeButton={false}` (used with TanStack `<Link>`). |
| `card.tsx` | 81 | plain divs | 7 parts incl. `CardAction`. **`size` prop (`default` \| `sm`)** driving a `--card-spacing` custom property (`--spacing(4)` / `--spacing(3)`). `ring-1 ring-foreground/10` instead of `border shadow`; `rounded-none`; `text-xs/relaxed`. |
| `checkbox.tsx` | 25 | `@base-ui/react/checkbox` | `size-4`, `rounded-none`, expanded hit area via `after:-inset-x-3 after:-inset-y-2`, lucide `CheckIcon` indicator. |
| `dialog.tsx` | 139 | `@base-ui/react/dialog` | Base UI names mapped to shadcn names (`Backdrop`→`DialogOverlay`, `Popup`→`DialogContent`). `DialogContent` takes `showCloseButton` (default true); **`DialogFooter` also takes `showCloseButton`** (default false) and renders a `Close`-rendered outline Button. Backdrop `bg-black/10 supports-backdrop-filter:backdrop-blur-xs`. No `AlertDialog` primitive at all. |
| `empty.tsx` | 89 | plain divs | `Empty`, `EmptyHeader`, `EmptyMedia` (variants `default` \| `icon`), `EmptyTitle`, `EmptyDescription`, `EmptyContent`. `border-dashed` is in the base class but no `border` width — callers add `className="rounded-lg border"` themselves. |
| `field.tsx` | 221 | plain elements + Label/Separator | Largest primitive. `FieldSet`, `FieldLegend` (`legend`\|`label` variants), `FieldGroup`, `Field` (orientations `vertical`\|`horizontal`\|`responsive`), `FieldContent`, `FieldLabel`, `FieldTitle`, `FieldDescription`, `FieldSeparator`, `FieldError`. `FieldError` accepts either children or an `errors: Array<{message?}>` array and de-dupes into a `<ul>`. **Not bound to any form library** — `data-invalid` / `aria-invalid` are set by hand at each call site. |
| `input.tsx` | 19 | `@base-ui/react/input` | `h-8`, `rounded-none`, `text-xs`, `dark:bg-input/30`. |
| `label.tsx` | 17 | plain `<label>` | `text-xs`, no Radix Label. |
| `separator.tsx` | 18 | `@base-ui/react/separator` | uses `data-horizontal:` / `data-vertical:` variants (Base UI attrs). |
| `skeleton.tsx` | 13 | plain div | `animate-pulse bg-muted rounded-none`. |
| `spinner.tsx` | 16 | lucide `Loader2Icon` | `role="status" aria-label="Loading"`, `size-4 animate-spin`. |
| `switch.tsx` | 31 | `@base-ui/react/switch` | `size` prop (`sm`\|`default`); odd pixel sizes `h-[18.4px] w-[32px]` / `h-[14px] w-[24px]`. Extended hit area via `after:`. |
| `table.tsx` | 88 | plain table elements | 8 parts, wrapped in `div[data-slot=table-container]` with `overflow-x-auto`. `text-xs`, `h-10` heads, `whitespace-nowrap` cells. |
| `textarea.tsx` | 17 | plain `<textarea>` | `field-sizing-content`, `min-h-16`, `rounded-none`, `text-xs`. |

**Missing primitives that the app hand-rolls instead** — relevant to a design-system migration:
- No `Select` — two raw `<select>` elements with hand-copied Tailwind: `src/components/connection/connection-form.tsx` (auth scheme picker, ~line 122, `h-8 rounded-none border-input …`) and `src/components/settings/model-key-card.tsx` (provider picker, ~line 168, `h-9 rounded-md … shadow-xs focus-visible:ring-[3px]` — visibly out of step with the rest, it's stock-shadcn-shaped, not base-lyra).
- No `Sidebar` primitive — the shell is hand-written CSS grid (see §4).
- No `AlertDialog`, `Tooltip`, `DropdownMenu`, `Popover`, `Tabs`, `Sheet`, `ScrollArea`, `Avatar`, `Command`, `Sonner` wrapper (the `Toaster` is imported straight from `sonner`).
- No code-block / `<pre>` primitive — three separate hand-rolled `<pre className="… rounded-md border bg-muted/50 p-3 font-mono text-xs">` blocks.

**Lint carve-out**: `biome.json` has an override for `apps/web/src/components/ui/**` turning off `a11y/noLabelWithoutControl` and `a11y/useSemanticElements`, with the note that "Cando does the same for its `packages/ui`". `apps/web/src/routeTree.gen.ts` is excluded from Biome entirely. Biome's `nursery/useSortedClasses` is on at `warn` with `functions: ["clsx","cva","cn"]`.

---

## 4. Screens and routes

12 route files under `apps/web/src/routes/`. `routeTree.gen.ts` (284 LOC) is generated by `@tanstack/router-plugin` with `autoCodeSplitting: true`.

### Entry and root

- `src/main.tsx` — creates the router: `defaultPreload: "intent"`, **`defaultPreloadStaleTime: 0`** (so React Query, not the router's loader cache, owns caching — comment cites Cando CAN-242), `scrollRestoration: true`, `defaultPendingComponent: Loader`, `defaultNotFoundComponent: RouteNotFound` (on the router, not the root route, so unmatched addresses hit it), `context: { queryClient }`, and a `Wrap` that mounts `QueryClientProvider`.
- `src/routes/__root.tsx` — **renders no chrome**: `<HeadContent/>`, `<Outlet/>`, `<Toaster richColors position="top-right" />` (sonner). `errorComponent: RouteError`. `head` sets title "Graft". Imports `../index.css`.

### Layout routes

- `src/routes/_auth/route.tsx` — **the guard and only the guard.** `beforeLoad` does `ensureQueryData({...sessionQuery, revalidateIfStale: true})`; if no session it `throw redirect({ to: "/login", search: { redirect: location.href } })`. Comment notes this is not enforcement — every read behind it re-checks the cookie server-side.
- `src/routes/_auth/_shell/route.tsx` — **pathless** chrome layer; renders `<AppShell><Outlet/></AppShell>`. The split (guard one level, chrome another) is explicitly Cando's arrangement (CAN-69, CAN-107).
- `src/routes/index.tsx` — `/` has no home; `beforeLoad` redirects to `DEFAULT_SIGNED_IN_PATH` = `/agents`.

### The shell

`apps/web/src/components/shell/app-shell.tsx` (117 LOC) — **hand-written, no shadcn Sidebar primitive**:

```
<div className="grid min-h-svh grid-cols-1 md:grid-cols-[14rem_minmax(0,1fr)]">
  <aside className="flex flex-col gap-4 border-b bg-sidebar px-3 py-4 text-sidebar-foreground md:border-r md:border-b-0">
    brand link → /agents: a size-6 rounded-md bg-foreground square with "G" + "Graft"
    <nav aria-label="Console" className="flex flex-row gap-1 md:flex-col">
      Agents (BotIcon) · Pending actions (InboxIcon, trailing <PendingCount/>) · Connections (PlugIcon) · Settings (SettingsIcon)
    <div className="mt-auto hidden md:block"><PersonFooter/></div>
  <main className="min-w-0 px-6 py-8 md:px-10">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">{children}</div>
```
- Fixed **14rem** sidebar on `md+`, collapses to a horizontal nav strip above the content on small screens. No collapse/expand, no mobile drawer, no `SidebarProvider`, no cookie-persisted state.
- `NavLink` is a local component; active state via TanStack `activeProps` → `bg-sidebar-accent text-sidebar-accent-foreground`. `to` is typed as a literal union of the four paths.
- `PendingCount` — `useQuery({...pendingActionsQuery, refetchInterval: 15_000})`, renders a `<Badge>` with the open count, nothing when zero. This is the only polling in the shell.
- `PersonFooter` — `authClient.useSession()` for name/email, plus a ghost icon-sm `LogOutIcon` button that calls `authClient.signOut()`, removes `sessionKeys.current`, `queryClient.clear()`, then navigates to `/login`.
- **No header bar at all.** No breadcrumbs, no top nav, no search, no theme toggle, no user dropdown.

**Page titles/descriptions/actions** — `apps/web/src/components/page-header.tsx` (21 LOC), used by every shell screen:
```tsx
<div className="flex flex-wrap items-start justify-between gap-4">
  <div className="flex flex-col gap-1">
    <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
    {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
  </div>
  {children ? <div className="flex items-center gap-2">{children}</div> : null}
</div>
```
`title` is a `ReactNode`, so the agent detail page passes a fragment with inline status badges; `description` likewise (agent detail passes token prefix + `<Time/>`).

### Screens

| route file | URL | what it shows |
|---|---|---|
| `routes/index.tsx` | `/` | nothing — redirects to `/agents`. |
| `routes/login.tsx` | `/login` | Sign-in door. `AuthCard` with email + password `Field`s, full-width submit ("Signing in…"), footer link to `/signup`. `validateSearch` runs `safeRedirectPath`; `beforeLoad` bounces a signed-in visitor to `search.redirect ?? /agents`. Errors go into a `<FieldError>` (no toast). |
| `routes/signup.tsx` | `/signup` | Sign-up door. Same `AuthCard`; name + email + password (`minLength={8}`, description "At least eight characters."). Email verification is off for the alpha (reason lives in `packages/auth/src/index.ts`). |
| `routes/_auth/_shell/agents.index.tsx` | `/agents` | Agents list. `PageHeader` + "New agent" button. Loader pre-fetches `agentsQuery` and `connectionsQuery`. Table columns: Agent (link), Token (`tokenPrefix…` in `<code>`), Cap (`count(n,"tool")`), Idle window (`count(n,"day")`), Created (`<Time/>`), Status (`revoked` destructive badge / `active` secondary badge). Empty state: `Empty` with `BotIcon`, "No agents yet", + a New agent button. Table wrapped in `<div className="rounded-lg border">`. Hosts `<CreateAgentDialog/>`. |
| `routes/_auth/_shell/agents.$agentId.tsx` | `/agents/$agentId` | Agent detail. Ghost back-button "All agents". `PageHeader` title = name + active/revoked badge; description = `Token <prefix>… · created <Time> [· revoked <Time>]`; action = destructive "Revoke token" (hidden when already revoked). Body: a `lg:grid-cols-2` grid — left column `HarnessSnippet` (hidden when revoked) + `ScopeEditor`, right column `LimitsForm` — then full-width `WorkingSetTable`, `ApprovalsCard`, `WorkingSetHistory`, and `RevokeAgentDialog`. Loader pre-fetches six queries in parallel. `key` props force remount of `ScopeEditor`/`LimitsForm` when the server data changes. |
| `routes/_auth/_shell/connections.index.tsx` | `/connections` | Connections list. `PageHeader` + "Add connection". One `ConnectionCard` per connection in a `flex-col gap-4` (cards, not a table). Empty state: `PlugIcon`, "No connections yet" with prose about agents proposing connections. Loader pre-fetches `connectionsQuery` + `toolsQuery`; tools are matched to a connection by **vendor** via `toolsOfConnection`. |
| `routes/_auth/_shell/pending.index.tsx` | `/pending` | Open asks across every agent. `PageHeader` (description enumerates the five ask situations) then one `PendingActionCard` per action. `useSuspenseQuery({...pendingActionsQuery, refetchInterval: 15_000})`. Empty state: `InboxIcon`, "Nothing is waiting on you". |
| `routes/_auth/_shell/pending.$id.tsx` | `/pending/$id?t=<token>` | **The handoff page.** `validateSearch` keeps `t` when it's a non-empty string. Two modes: with `t`, `useQuery(pendingActionQuery(id, t))` — the server verifies the token against the row; with no `t`, it finds the action in the person's open list. Pending → `<Loader/>`. Error → a `Refusal` `Empty` with `ShieldAlertIcon`, a headline derived from `error.details.reason` (`tampered` → "This link is not one Graft issued", `expired` → "This link has expired", `consumed` → "This link was already used", 404 → "There is no such pending action", else "This link cannot be opened"), the server's own message, and the constant reassurance "Nothing has been approved or declined.", plus an outline button to `/pending`. Success → back-link + `<PendingActionCard onAnswered={() => navigate({to:"/pending"})}/>`. |
| `routes/_auth/_shell/settings.tsx` | `/settings` | Settings. `PageHeader` ("What is yours across every agent: the model your acquire jobs run on.") and exactly one card, `ModelKeyCard`. Loader pre-fetches `modelKeyQuery`. |

### Approvals

Approvals are **not their own route** — they are `ApprovalsCard` on the agent detail page (`src/components/agent/approvals-card.tsx`, 157 LOC): a Card wrapping a Table with columns Tool (wire name `vendor__name` + `ToolAnnotations`), Answer (`allowed` secondary / `denied` destructive badge), Decided (`<Time/>`), "Asks every call" (a `Switch` for destructive tools that can only be switched *off* — relax has no inverse server-side; non-destructive shows the words `never`/`once`), and a ghost "Withdraw" button. Empty body: "Nothing answered yet — the first write this agent runs will ask."

### Tools / working set

Also on the agent detail page, no dedicated route:
- `src/components/agent/working-set-table.tsx` (98 LOC) — Card titled "Working set" with a `<Badge variant="secondary">{n} of {cap}</Badge>`; Table columns Tool (`vendor__name` + truncated description), Asks (`ToolAnnotations`), Promoted by (`the agent` / `a publish` / `the rule`), Promoted, Last used (`<Time/>` or "never"). Empty: a `<p>`, not an `Empty`.
- `src/components/agent/working-set-history.tsx` (80 LOC) — Card "History"; Table columns When / Change (`promoted` default badge, `demoted` outline badge) / Tool / Cause, with a `CAUSE` map: `agent`→"the agent asked", `publish`→"published by the agent", `idle`→"unused past the idle window", `cap`→"over the working-set cap", `revoke`→"its connection was revoked".
- The toolbox as a whole has **no screen** — `toolsQuery` (`GET /api/tools`) is only used to decorate connections and approvals.

### OAuth callback

There is **no console route for the OAuth callback.** The callback page is server-rendered HTML from `apps/server/src/oauth.ts` (`callbackPage()`, ~line 308) at `GET /api/oauth/callback`, with its own inline `<style>` (`font: 15px/1.5 system-ui, sans-serif; color:#111; background:#fafafa`) — completely outside the design system. It shows a title ("Connected" / "Not connected" / "Something went wrong") and a message, `postMessage`s the opener, announces on a same-origin `BroadcastChannel`, and auto-closes after 1.5 s on success. The console side runs the popup and waits: `src/lib/oauth-consent.ts` + `src/components/connection/use-oauth-consent.ts`, with UI in `ConsentStatus` (`src/components/connection/oauth-client-notice.tsx`).

---

## 5. Patterns

**Forms.** No form library at all — no react-hook-form, no TanStack Form, no zod resolver in the console. Every form is `useState` per field plus an `onSubmit` that calls `event.preventDefault()`. Validation comes from two places:

1. **Shared domain rules imported at runtime from workspace packages** — `apps/web/src/lib/connection-form.ts` (329 LOC) imports `validateVendor`, `validateDisplayName`, `validateHostSet`, `validateSchemeConfig`, `validateCredentialFields`, `HOST_NOT_PUBLIC` from `@graft/core/connection/connection.rules`; OAuth helpers from `@graft/core/connection/oauth.rules`; and the scheme tables `SCHEME_CREDENTIAL_FIELDS`, `SCHEME_OPTIONAL_CREDENTIAL_FIELDS` from `@graft/proxy/credential-fields` and `SCHEME_PARAMETERS` from `@graft/proxy/scheme-parameters`. These three modules are kept browser-safe on purpose (GRA-28); `vite build` in `check-types` is the guard. Errors are a flat `DraftErrors = Record<string,string>` keyed by field path (`"primaryHost"`, `"credential.apiKey"`, `"schemeConfig.headerName"`).
2. **Server refusals mapped back onto fields** — e.g. `connection-ask-card.tsx` catches `ApiError` 400 with `details.reason === "host_not_public"` and puts the message under `primaryHost` or `hosts`; `model-key-card.tsx` reads `details.field`.

Field markup convention: `<Field data-invalid={…}> <FieldLabel htmlFor=…> <Input aria-invalid=…> <FieldDescription> {error ? <FieldError> : null} </Field>`, IDs namespaced with an `idPrefix` so the same fields can appear inside a dialog and inside an ask card on the same page.

**Tables/lists.** Four tables (agents list, working set, approvals, working-set history, connection calls = five), all raw `Table` primitive, all client-rendered from an array. No sorting, no pagination, no column config, no TanStack Table, no row selection. Connections use **cards** rather than a table. `ConnectionPicker` (scope) is a `<ul className="flex flex-col divide-y rounded-md border">` of `Checkbox` + `<label>` rows.

**Dialogs.** Five: `CreateAgentDialog`, `RevokeAgentDialog`, `AddConnectionDialog`, `ReenterCredentialDialog`, `RevokeConnectionDialog`. All controlled with a local `open`/`onOpenChange` pair owned by the parent screen; the trigger is always a plain `<Button onClick>` rather than `DialogTrigger`. Forms inside dialogs use `className="contents"` on the `<form>` so the dialog's grid gap still applies. Reset-after-close uses `setTimeout(…, 200)` "so the token is not visibly blanked mid-fade". Sizes are passed by className: `sm:max-w-lg` (create agent), `max-h-[90svh] overflow-y-auto sm:max-w-2xl` (add connection); default is `sm:max-w-sm`.

**Empty states.** The `Empty` primitive with `EmptyMedia variant="icon"`, always with an explanatory `EmptyDescription` written in the product's voice. Callers add the frame themselves (`className="rounded-lg border"` on the four screen-level ones, `className="mx-auto h-full max-w-md px-4"` on the two route-level ones). Inline "nothing here" states inside cards are plain `<p className="text-muted-foreground text-sm">` instead (working set, history, approvals, connection calls, connection picker) — an inconsistency.

**Loading.** Three mechanisms: (a) route-level — `defaultPendingComponent: Loader` (`src/components/loader.tsx`: centred `Spinner` in a `min-h-40` box); (b) loaders call `ensureQueryData` so most screens have data before they render and use `useSuspenseQuery`; (c) in-place — `Skeleton` is used exactly once (`connection-calls.tsx`, `h-16 w-full`). Buttons show text swaps for pending state: "Saving…", "Creating…", "Revoking…", "Connecting…", "Signing in…", "Waiting for the consent…".

**Toasts.** `sonner` — `<Toaster richColors position="top-right" />` in `__root.tsx`. Two sources:
- **Global mutation errors** via `MutationCache.onError` in `apps/web/src/lib/query-client.ts`: `toast.error(error instanceof ApiError ? error.message : "Could not reach the server")`. A failed *query* deliberately does not toast — it goes to the route's error boundary.
- **Per-mutation successes** with `toast.success(title, { description })`, always a two-line message that says what changed downstream ("Scope saved" / "In effect on the agent's next call."; "Approved" / "The agent's waiting call resumes…"). `toast.message` (neutral) is used for the OAuth intermediate step.

`QueryClient` defaults: `staleTime: 10_000`, `retry` returns false for any `ApiError` and otherwise `failureCount < 2`.

**Destructive confirmations.** No `AlertDialog` primitive — they are plain `Dialog`s with a `variant="outline"` "Keep it" and a `variant="destructive"` confirm ("Revoke token" / "Revoke connection"). No typed-name confirmation. The revoke-connection toast reports counts of what was deleted using `count(n, noun)`.

**Copy-to-clipboard / the one-time agent token.** `apps/web/src/components/copy-button.tsx` — `navigator.clipboard.writeText`, outline `sm` button, swaps `CopyIcon`→`CheckIcon` and label→"Copied" for 1500 ms via a `useEffect` timer. No toast, no fallback for non-secure contexts.

The token flow is `apps/web/src/components/agent/token-once.tsx`: shown only inside `CreateAgentDialog` after a successful create. It renders an `Alert` (`KeyRoundIcon`, "This token is shown once", "Graft keeps only its hash…") then three `Snippet` blocks — the token itself ("Copy token"), the `export GRAFT_TOKEN='…'` shell line, and the `mcpServers` block — each with a hint line. The dialog's only footer action is "I have copied the token". `HarnessSnippet` on the agent page re-shows the `mcpServers` block and the prefix but never the token.

`Snippet` (exported from `token-once.tsx`) is the de-facto code-block component: a label row with a `CopyButton`, then `<pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed"><code>{code}</code></pre>`, then an optional hint `<p>`. `UnknownAskCard` duplicates a similar `<pre>` for raw JSON payloads. There is no syntax highlighting anywhere.

**Badges / status chips.** All via the `Badge` primitive, variant chosen inline at each site (no central status→variant map except two):
- **Tool kinds** — `apps/web/src/components/tool-annotations.tsx`: `read-only` → `secondary`, `destructive` → `destructive`, otherwise `write` → `outline`. This is the one shared chip component and it is used in four places (tool ask card, connection card tool list, working set table, approvals table).
- **Agent status** — inline in two places: `revoked` → `destructive`, `active` → `secondary`.
- **Connection status** — a `badge` lookup object in `connection-card.tsx` keyed off `connectionStatus()` (`revoked` → destructive + an extra `awaiting reconnection` outline; `awaiting_credential` → outline, text varies for OAuth; `awaiting_consent` → outline; `consent_required` → destructive "needs re-consent"; `connected` → secondary). The status function itself lives in `src/lib/connection-queries.ts`.
- **Call outcome** — `OUTCOME_VARIANT` map in `connection-calls.tsx`: `ok`→secondary, `error`→destructive, `refused`→outline. Plus a `dry run` outline badge.
- **Approval decision** — `allowed`→secondary, `denied`→destructive.
- **Working-set change** — `promoted`→`default`, `demoted`→`outline`.
- **Provenance chips** — outline badges with prose labels: `written by the agent's model`, `proposed by the agent's model`, `in the agent's words`, plus vendor slug and scheme name as outline badges.
- **Pending action kinds** are *not* badged — the kind is carried in the card's sentence ("<agent> asks to run `tool`" / "acquire a tool against X" / "connect X" / "reconnect X"), see below.

**Pending action cards.** `apps/web/src/components/pending/` — a dispatch file and one file per kind, exactly as AGENTS.md prescribes ("a new kind is one branch and one file"):
- `pending-action-card.tsx` (33 LOC) — `switch (readAsk(action).kind)` over `tool` / `build` / `connection` / `credential` / default.
- `ask-card.tsx` (136 LOC) — the shared frame: `useAnswerAsk()` mutation hook (invalidates pending, agent and approval keys, toasts Approved/Declined with a consequence sentence) plus `<AskCard>` which renders a `Card` with title "`<agent>` asks to …", a description line of `Asked <Time> · expires/answered/expired <Time> · <where>`, an optional body, and a footer that is either Decline/Approve buttons (open) or the settled sentence (closed). `approveLabel` overrides the verb — "Connect", "Reconnect", "Save credential", "Save and reconnect". Also exports `<Hosts>` which renders each host as an inline `<code>`.
- `tool-ask-card.tsx` — wire name + `ToolAnnotations`; a `<figure>`/`<blockquote>` quoting the model-written description behind a "written by the agent's model" badge; for destructive tools a bordered box with a `Switch` "Stop asking for every call of this destructive tool" whose value rides along in the same answer as `relax`.
- `build-ask-card.tsx` — `acquire` against a connection, once per agent per connection.
- `connection-ask-card.tsx` (229 LOC) — the richest: renders the full editable connection form pre-filled from the agent's proposal (`ConnectionFormFields` + `HostsNotice` + `OAuthClientNotice` + `CredentialFields` + `ConsentStatus`), posts to the action's own submit route, and for OAuth hands off to the popup so the *callback* settles the ask. Closed asks collapse to a `<dl>` of primary host + scheme.
- `credential-ask-card.tsx` (164 LOC) — re-entry after a 401/403 or a revoke; quotes the vendor's reason behind an "in the agent's words" badge; for OAuth with the client secret intact it asks for nothing and just offers "Reconnect".
- `unknown-ask-card.tsx` — renders the kind and a `<pre>` of the raw payload rather than hiding an ask a waiting call depends on.

**Misc.** `src/components/time.tsx` — `<time dateTime title={formatDateTime}>{formatRelative}</time>`, backed by `Intl.RelativeTimeFormat`/`Intl.DateTimeFormat` in `src/lib/format.ts`. `count(n, noun)` pluralises.

---

## 6. Data layer

**Fetch wrapper**: `apps/web/src/lib/api.ts` (70 LOC). One function `api<T>(path, {method, body, signal})`, `API_BASE = "/api"`, `credentials: "same-origin"`, JSON in/out, `204` → `undefined`. Failures become `ApiError { status, code, message, details }` from the server's `{ error, message, details? }` shape. Also exports `Jsonified<T>`, the recursive `Date → string` transform applied to every server type.

**Types flow from the server without codegen.** Wire shapes are imported as types from `@graft/server/api` (`ToolOutput`, `WorkingSetEntryOutput`, `WorkingSetChangeOutput`, `ConnectionCallOutput`, `PendingActionCard`), `@graft/core` (`AgentOutput`, `ConnectionOutput`, `RevokeConnectionResult`, `ModelKeyOutput`, `ServiceErrorCode`), `@graft/db` (`ApprovalRow`) and `@graft/mcp` (`ToolAskPayload`, `BuildAskPayload`, `ConnectionProposalPayload`, `CredentialAskPayload`) — never re-written.

**TanStack Query**: yes, v5. `src/lib/query-client.ts` holds the single client (config in §5). Query options + mutation functions are grouped per aggregate in `src/lib/*-queries.ts`, each with a `*Keys` object:

| module | keys | queries | mutations |
|---|---|---|---|
| `agent-queries.ts` | `agentKeys.{all,one,workingSet,changes}` | `agentsQuery`, `agentQuery(id)`, `workingSetQuery(id)`, `workingSetChangesQuery(id, limit=100)` | `createAgent`, `updateAgentLimits`, `revokeAgent`, `setAgentScope` |
| `connection-queries.ts` | `connectionKeys.{all,calls}`, `toolKeys.all` | `connectionsQuery`, `connectionCallsQuery(id, limit=25)`, `toolsQuery` | `createConnection`, `setConnectionCredential`, `revokeConnection`, `submitConnectionProposal(actionId,…)`, `submitCredentialRequest(actionId,…)`, `fetchConnection` |
| `pending-action-queries.ts` | `pendingKeys.{all,one}` | `pendingActionsQuery`, `pendingActionQuery(id, token)` | `answerPendingAction`. Also `readAsk()` (the one payload narrowing) and `isOpen()` |
| `approval-queries.ts` | `approvalKeys.ofAgent` | `approvalsQuery(agentId)` | `relaxApproval`, `withdrawApproval` |
| `model-key-queries.ts` | `modelKeyKeys.current` | `modelKeyQuery` | `setModelKey`, `removeModelKey`. Also `MODEL_KEY_PROVIDERS` |
| `oauth-consent.ts` | `oauthKeys.redirectUri` | `redirectUriQuery` (`staleTime: Infinity`) | `startOAuthConsent`. Plus `awaitConsent`, `openConsentPopup`, `readConsentMessage`, `serverOriginOf` |
| `session-queries.ts` | `sessionKeys.current` | `sessionQuery` (`staleTime: 30_000`, never throws) | — |

Route loaders call `context.queryClient.ensureQueryData(...)` (often `Promise.all` of several), components then `useSuspenseQuery` the same options.

**Auth session handling.** `apps/web/src/lib/auth-client.ts`: `createAuthClient({ baseURL: new URL("/api/auth", window.location.origin).toString() })` from `better-auth/react`. Two readers by design: components use `authClient.useSession()` (Better Auth's reactive store); the routing layer uses `sessionQuery`, which wraps `authClient.getSession()` and returns `null` for both signed-out and transport failure. Sign-in, sign-up and sign-out all `queryClient.removeQueries({ queryKey: sessionKeys.current })` rather than waiting out the 30 s stale time. Post-login redirect is sanitised by `src/lib/safe-redirect.ts` (same-origin path only; rejects `//`, backslashes, leading whitespace, and `/login`/`/signup` themselves).

**Where the mcpServers snippet is generated**: `apps/web/src/lib/mcp-snippet.ts` (35 LOC), a pure module with its own test. `TOKEN_ENV_VAR = "GRAFT_TOKEN"`; `mcpEndpointUrl(origin)` = `<origin>/mcp`; `mcpServersSnippet(origin)` returns `JSON.stringify(..., null, 2)` of:
```json
{ "mcpServers": { "graft": { "type": "http", "url": "<origin>/mcp",
    "headers": { "Authorization": "Bearer ${GRAFT_TOKEN}" } } } }
```
and `exportTokenLine(token)` = `export GRAFT_TOKEN='<token>'`. Callers pass `window.location.origin` (in `harness-snippet.tsx` and `token-once.tsx`). The block deliberately embeds an env reference, not the token, so it can be committed.

---

## 7. Tests and CI

**Console tests**: four Vitest files, all pure-helper unit tests under `src/lib`, zero component tests:
- `apps/web/src/lib/connection-form.test.ts` (265 LOC)
- `apps/web/src/lib/mcp-snippet.test.ts` (25)
- `apps/web/src/lib/oauth-consent.test.ts` (51)
- `apps/web/src/lib/safe-redirect.test.ts` (33)

There is **no `vitest.config.ts`** in `apps/web` (the tsconfig `include` lists one, but the file doesn't exist), no jsdom/happy-dom, no `@testing-library/*`, no Playwright, no Storybook, no visual/snapshot testing anywhere in the repo. AGENTS.md states the policy explicitly: *"Components carry no tests; the pure helpers under `src/lib` do, and `check-types` runs `vite build` first so a broken bundle fails CI as a type error would."*

**Root scripts** (`package.json`): `dev`/`build`/`check-types`/`test` are `turbo run …`; `check` = `biome check --write .`; `lint` = `biome ci .`.

**CI** (`.github/workflows/ci.yml`) — one job, `Typecheck, Lint & Test` (the required status check), on every `pull_request` and on `push` to `main`, ubuntu-latest with a `postgres:18` service. Steps, in order: refuse merge-conflict markers → check ADR frontmatter and citations → pnpm/action-setup → setup-node 24 → `pnpm install --frozen-lockfile` → **`pnpm run check-types`** → **`pnpm run lint`** → drizzle drift check → migration-chain check → build sandbox image → **`pnpm run test`** → build the server image → three "the image refuses to start" assertions.

What that means for `apps/web` specifically — there is **no web-specific step**. The web app is covered only through the three turbo fan-outs:
- `check-types` → `vite build && tsc -p tsconfig.json` (so the production bundle is built on every CI run and a browser-unsafe import fails here).
- `lint` → `biome ci .` across the repo, with the `apps/web/src/components/ui/**` a11y override and the `routeTree.gen.ts` exclusion.
- `test` → `vitest run` over the four helper tests.

There is no `build` step in CI other than inside `check-types` and inside the Docker image build (the Dockerfile's `build` stage runs the console's `vite build`). No Lighthouse, a11y, or visual job.

---

## 8. Sizes

- `apps/web/src` total: **7,306 lines** across `.ts`/`.tsx`/`.css`; **7,022** excluding the 284-line generated `routeTree.gen.ts`.
  - components: 4,578 LOC (35 feature `.tsx` + 16 ui `.tsx`)
  - `src/lib`: 1,528 LOC, of which 374 are the four test files → **1,154 LOC of lib**
  - `src/index.css`: 130 LOC
  - routes: 12 files (`__root.tsx`, `index.tsx`, `login.tsx`, `signup.tsx`, `_auth/route.tsx`, `_auth/_shell/route.tsx`, and six screens)
- **Components: 51 `.tsx`** total under `src/components` — 16 ui primitives + 35 feature components (5 loose: `copy-button`, `loader`, `page-header`, `route-error`, `route-not-found`, `time`, `tool-annotations` — 7 loose actually; the rest in `agent/` 8, `auth/` 1, `connection/` 9 incl. one `.ts` hook, `pending/` 7, `settings/` 1, `shell/` 1).
- **Routes: 8 addressable URLs** (`/`, `/login`, `/signup`, `/agents`, `/agents/$agentId`, `/connections`, `/pending`, `/pending/$id`, `/settings` — 9 counting `/settings`), from 12 route files.
- Largest files: `settings/model-key-card.tsx` 283, `connection/connection-card.tsx` 237, `pending/connection-ask-card.tsx` 229, `ui/field.tsx` 221, `connection/connection-form.tsx` 214, `connection/reenter-credential-dialog.tsx` 182, `connection/add-connection-dialog.tsx` 166, `pending/credential-ask-card.tsx` 164, `agent/create-agent-dialog.tsx` 158, `agent/approvals-card.tsx` 157.
- `src/lib/connection-form.ts` 329 LOC is the biggest lib module.

---

## 9. ADRs about the console

`docs/adr/` holds 16 ADRs. Grepping for console/web/design/shadcn/tailwind:

- **`0006-the-console-is-the-channel-to-the-human.md`** (status: accepted) — the only ADR whose subject is the console. Decides that every human-only step goes through the web console reached by a handoff URL; MCP elicitation is layered on top for approvals only and never for secrets; a CLI is a thin wrapper. Consequences that the UI implements literally: *"Graft has a web console from the first release"*; *"An approval can be answered later"* (durable pending-action record with a URL — the `/pending/$id` page); *"The handoff URL is a phishing-shaped artefact… It is signed, short-lived, bound to the agent that requested it, and displays the requesting agent and the vendor host on the page"* (hence `AskCard`'s agent name in the title and `<Hosts>` in the description line); and the GRA-42 amendment about Hermes' elicitation buttons — a destructive tool asks before every call "until the person relaxes it in the console (ADR 0008)".
- **`0016-hermes-first-hosted-first-core-before-console.md`** — sequencing: "core before console"; the console for handoffs and approvals is in the first milestone slice, with "Person-owned, agent-scoped tenancy and the console" as step 2.
- **`0008-reads-pass-writes-ask-once.md`** — the approval grain the badges and the relax switch encode ("A tool marked destructive asks on every call until the person relaxes it in the console"; "An approval is a durable record answerable later").
- **`0005-oauth-clients-belong-to-the-person.md`** — the OAuth consent handoff, the person-registered client, the redirect URI, and the accepted friction of "the console dance per vendor". (Note: most "console" hits in this file mean the *vendor's* console, not Graft's.)
- **`0007-a-person-owns-an-agent-scopes.md`** — token shown once + prefix stored, scope as a set, revoke semantics; drives the agent detail page.
- **`0009-a-working-set-contracts-by-rule.md`** — "per agent and editable in the console" (the cap/idle `LimitsForm`).
- **`0011-copied-from-cando-and-modern-cando-adopts-it-later.md`** — the general "copied from Cando, re-read not trusted" rule that the console's shape (route split, query-client settings, biome a11y override, dependency catalog) repeatedly cites.

**There is no ADR about the console's design system, styling, tokens, typography, or shadcn.** The only written design decision is the comment block at the top of `src/index.css`:

> *"Graft has one SPA and no design file behind it yet, so these are the library's defaults and not Cando's imported Figma variables (`AGENTS.md`, "The console"); a `packages/ui` and a token import arrive if a second app or a design system ever does."*

and the matching paragraph in `AGENTS.md` § "The console" ("There is deliberately no `packages/ui`: one SPA does not warrant a second workspace, and the primitives are the registry's files"). So the alignment work has no ADR standing in its way; it would, by the repo's own conventions, warrant a new ADR (and the CI step that validates ADR frontmatter and citation numbering would need it to carry a `status:` line).

---

## Summary of the gaps against Cando's target

1. **Typography**: no font is loaded or declared; no `--font-sans`/`--font-mono` in `@theme`. Inter would be an addition, not a replacement.
2. **Radii**: `--radius: 0.625rem` exists and maps to four scale steps, but the `base-lyra` primitives are uniformly `rounded-none` and feature code hand-writes `rounded-md`/`rounded-lg`. Adopting Cando radii means changing the primitives, not the token.
3. **Shadows**: none defined, one `shadow-xs` in the codebase; Card and Dialog use `ring-1 ring-foreground/10`.
4. **Primitive base**: Base UI (`@base-ui/react` ^1.8.0) via shadcn style `base-lyra`, not Radix. `render`/`nativeButton={false}` polymorphism, `data-open`/`data-checked`/`data-horizontal` attribute variants. If Cando is on Radix-based shadcn, every one of the 16 primitives plus every call site that uses `render={<Link/>}` or `onCheckedChange` changes.
5. **Type scale**: base-lyra's `text-xs` default across buttons, inputs, cards, tables and badges is markedly denser than stock shadcn's `text-sm`.
6. **App shell**: hand-written 14rem CSS-grid sidebar with no header, no collapse, no mobile drawer, no theme toggle — no `Sidebar` primitive to migrate from.
7. **Dark mode**: fully tokenised, entirely unreachable (nothing sets `.dark`).
8. **Missing primitives** the app fakes: Select (two divergent hand-rolled `<select>`s), AlertDialog (plain Dialogs), code block (three ad-hoc `<pre>`s), Sidebar, Tooltip, DropdownMenu.
9. **Unused token pairs** already present: `--success` / `--warning` and all eight `--sidebar-*`.
10. **Out-of-system surface**: the server-rendered OAuth callback page (`apps/server/src/oauth.ts`) has its own inline CSS and system-ui font.