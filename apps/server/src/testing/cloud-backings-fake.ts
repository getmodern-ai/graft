import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { createLocalKeyring } from "@graft/vault";

import type { CloudBackings, CloudBackingsInput } from "../backings";

/**
 * A module shaped like the private package's entry, for `backings.test.ts`: the selector imports it
 * by path where it would import `@graft/cloud-backings`, and the test asserts what came back. The
 * mirror here writes what it was handed into the store it was handed, which is how the test sees
 * that the input reached the factory without the two sharing any state.
 */
export function createCloudBackings(input: CloudBackingsInput): CloudBackings {
  const keyring = createLocalKeyring("fake-cloud-secret-that-is-long-enough-32");
  return {
    sandbox: createFakeSandboxBackend(),
    keyring: { ...keyring, id: "fake-cloud" },
    mirror: {
      mirrorVersion: async (toolboxId, versionPath) => {
        await input.store.writeTree(toolboxId, versionPath, [
          {
            path: "mirrored.json",
            content: JSON.stringify({
              nodeEnv: input.env.NODE_ENV,
              proxy: input.env.GRAFT_PROXY_PUBLIC_URL,
              marker: input.raw.GRAFT_FAKE_CLOUD_MARKER ?? null,
            }),
          },
        ]);
      },
    },
  };
}
