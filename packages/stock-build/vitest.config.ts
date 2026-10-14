import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each case runs the whole acquire loop under a scripted model and then the harness's three
    // proofs: the real check (the TypeScript compiler, cold) and the runner as a child process.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
