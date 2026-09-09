import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The service suite runs the real check, which loads the TypeScript compiler in a worker on
    // every call — a second or two cold. The Docker suite (`publish.docker.test.ts`) creates
    // containers and runs a real `npm install` against the registry, tens of seconds, and builds the
    // sandbox image when it is missing; its hooks carry the build.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    // One Docker daemon: two files racing the same image build would race the daemon's build lock.
    fileParallelism: false,
  },
});
