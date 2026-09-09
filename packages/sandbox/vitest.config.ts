import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The conformance suite starts real processes and waits on real timeouts (a `sleep 2` that must
    // outlive a 0.3 s wait, a kill at one second); the default five seconds is too close to them.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
