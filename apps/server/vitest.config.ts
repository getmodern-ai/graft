import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `database.integration.test.ts` migrates a fresh database and signs persons up through Better
    // Auth's password hashing; the default five seconds is too close to that on a cold CI runner.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
