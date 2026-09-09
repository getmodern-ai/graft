import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { createNoopToolboxMirror } from "@graft/toolbox";
import { createLocalKeyring } from "@graft/vault";

/** A module whose three seams are whole and whose store is not — one verb of six — for `backings.test.ts`. */
export function createCloudBackings() {
  return {
    sandbox: createFakeSandboxBackend(),
    keyring: createLocalKeyring("fake-cloud-secret-that-is-long-enough-32"),
    mirror: createNoopToolboxMirror(),
    store: { readTree: async () => [] },
  };
}
