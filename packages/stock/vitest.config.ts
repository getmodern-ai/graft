import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The harness runs the real check, which loads the TypeScript compiler in a worker on every
    // call: a second or two cold, per stock tool.
    testTimeout: 60_000,
  },
});
