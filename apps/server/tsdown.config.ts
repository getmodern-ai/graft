import { defineConfig } from "tsdown";

/**
 * The server as one deployable directory (`apps/server/Dockerfile`, GRA-33). The workspace packages
 * are inlined and every third-party dependency stays an import, resolved from `node_modules` at run
 * time — the same way the code runs in development, so the bundle changes where the code lives and
 * nothing about what it loads. `typescript6` is the one that could not be bundled anyway: the check
 * reads TypeScript's lib files off the package on disk.
 *
 * Four things in the workspace resolve a file off `import.meta.url`, and each says a bundler has to
 * carry that file beside the bundle. Here they land where those constants expect them, relative to
 * `dist/`:
 *
 *   - `@graft/runner`'s `runner.mjs` → `dist/runner.mjs`               (`./runner.mjs`)
 *   - `@graft/runner`'s `skills/`    → `apps/server/skills/`           (`../skills`)
 *   - `@graft/db`'s `drizzle/`       → `apps/server/drizzle/`          (`../drizzle/`)
 *   - `@graft/check`'s worker        → `dist/module-check.worker.mjs`  (the `.mjs` branch of `workerUrl`)
 *
 * The worker is a second entry rather than a chunk because Node loads it by file name into a fresh
 * thread; `keys` is the third, so a compose user can mint secrets from the image without pnpm.
 * `skills/` and `drizzle/` sit beside `dist/` rather than inside it because the constants say
 * `../`; both are gitignored as build output.
 */
export default defineConfig({
  entry: {
    index: "./src/index.ts",
    "module-check.worker": "../../packages/check/src/module-check.worker.ts",
    keys: "./src/scripts/generate-keys.ts",
  },
  format: "esm",
  platform: "node",
  outDir: "./dist",
  clean: ["./dist", "./skills", "./drizzle"],
  deps: {
    neverBundle: true,
    alwaysBundle: [/^@graft\//],
  },
  // A directory lands *inside* `to` under its own name, so the two directories are copied to `.`.
  copy: [
    { from: "../../packages/runner/src/runner.mjs", to: "./dist" },
    { from: "../../packages/runner/skills", to: "." },
    { from: "../../packages/db/drizzle", to: "." },
  ],
});
