// Tailwind emits nothing for an unknown utility — no error, no warning, just a property that
// never applies. That is how Cando shipped a transparent switch knob under `bg-switch-off-thumb`.
// This asserts every design-token utility the console references actually exists in the compiled
// CSS (ADR 0017) — Cando's `packages/ui/scripts/check-token-utilities.mjs`, pointed at this app.
//
// It needs a build first: `pnpm --filter @graft/web build`, or `pnpm run check-types`, which runs
// one. Without `dist/assets` it throws rather than passing on nothing.
//
// Two traps this has to avoid, both of which produced wrong answers first time:
//   - variant-prefixed utilities compile to `.hover\:bg-x:hover`, so looking for a leading `.`
//     misses them;
//   - a bare substring match lets `bg-success` satisfy a check for `bg-success-80`, so the match
//     needs a class-name boundary.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolved from this file so the script works from any cwd.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const CSS_DIR = `${root}apps/web/dist/assets`;
const GLOBALS = `${root}apps/web/src/index.css`;
const SOURCE_DIRS = [`${root}apps/web/src`];

/**
 * The guards' own fixtures name utilities on purpose — `bg-sidebar-border` in a test that checks a
 * longer word is not mistaken for a palette colour — and nothing under `src/tokens/` or in a test
 * renders, so a utility written there never has to compile. Skipped for the reason
 * `check-design-tokens.mjs` skips the same two: scanning them would make the guard's suite a
 * violation of the guard.
 */
const SKIP_FILE = /\.test\.(ts|tsx)$|routeTree\.gen\.ts$/;
const SKIP_DIR = [`${root}apps/web/src/tokens`];

const cssFiles = (await readdir(CSS_DIR)).filter((f) => f.endsWith(".css"));
if (!cssFiles.length) throw new Error("no built CSS found — run the build first");
const css = (await Promise.all(cssFiles.map((f) => readFile(`${CSS_DIR}/${f}`, "utf8")))).join(
  "\n",
);

// Every colour token the theme exposes, longest first so `success-80` wins over `success` when
// matching a utility's suffix.
const globals = await readFile(GLOBALS, "utf8");
const tokens = [...globals.matchAll(/--color-([a-z0-9-]+):/g)]
  .map((m) => m[1])
  .sort((a, b) => b.length - a.length);

const UTILITIES = ["bg", "text", "border", "ring", "fill", "stroke", "divide", "outline"];
const used = new Map();

// `.ts` as well as `.tsx`: a utility defined in a plain-TS status map and passed into a component
// fails exactly as silently as one written in JSX, and scanning only `.tsx` would leave those
// unguarded — Cando caught exactly that on one of its pull requests.
async function* sourceFiles(dir) {
  if (SKIP_DIR.includes(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) yield full;
  }
}

for (const dir of SOURCE_DIRS) {
  for await (const path of sourceFiles(dir)) {
    const src = await readFile(path, "utf8");
    const label = path.replace(root, "");
    // Any bare word that looks like a utility, ignoring variant prefixes and opacity modifiers.
    for (const m of src.matchAll(
      /[\w[\]="'&>*.:-]*?((?:bg|text|border|ring|fill|stroke|divide|outline)-[a-z0-9-]+)/g,
    )) {
      const cls = m[1];
      const prefix = UTILITIES.find((u) => cls.startsWith(`${u}-`));
      if (!prefix) continue;
      const suffix = cls.slice(prefix.length + 1);
      // Assert on anything in our namespaces, *including* names that are not known tokens — a
      // typo produces exactly that, and filtering to known tokens would skip the one case worth
      // catching.
      const ours =
        tokens.includes(suffix) ||
        /^(custom|switch|sidebar|chart|success|warning|info|ring-focus|opacity|scrim)-/.test(
          suffix,
        );
      if (!ours) continue;
      if (!used.has(cls)) used.set(cls, label);
    }
  }
}

const missing = [];
for (const [cls, file] of used) {
  const boundary = new RegExp(`${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`);
  if (!boundary.test(css)) missing.push(`${cls}  (${file})`);
}

console.log(`checked ${used.size} design-token utilities against ${tokens.length} tokens`);
if (missing.length) {
  console.error(`\n${missing.length} DO NOT COMPILE — they will silently do nothing (ADR 0017):`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
console.log("all resolve");
