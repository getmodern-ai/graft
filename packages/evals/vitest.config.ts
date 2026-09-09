import { defineConfig } from "vitest/config";

/**
 * The unit tests, which are not evals. The scorers are deterministic and cost nothing, so they run on
 * every commit; the harness self-test runs the whole loop under a scripted model, which is what
 * proves the scorers can go green before a real model is asked to. The evals themselves call a
 * provider and run by name — `pnpm --filter @graft/evals eval` — never from `pnpm test`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
