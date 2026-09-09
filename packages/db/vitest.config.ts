import { defineConfig } from "vitest/config";

/**
 * No `env` block and no database. `src/index.ts` opens a pool only when `createDb` is *called*, and
 * a repo module reaches it only through `import type { DbOrTx }`, which `verbatimModuleSyntax`
 * erases — so a suite here pulls in the schema and drizzle and nothing else, and pins the SQL a
 * query builder renders rather than what Postgres does with it. The one suite that needs Postgres
 * lives in `apps/server` and says so by reading `TEST_DATABASE_URL`.
 */
export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
    },
  },
});
