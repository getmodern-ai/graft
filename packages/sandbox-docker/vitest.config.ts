import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test here creates real containers: a cold `ensure` is around a second, an `install` that
    // reaches the registry is tens of seconds, and the fixture builds the image when it is missing.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    // One Docker daemon, one suite at a time: the fixtures name their networks and volumes per run,
    // but two files racing the same image build would race the daemon's build lock.
    fileParallelism: false,
  },
});
