import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { createLocalKeyring } from "@graft/vault";

/** A module with the right export and the wrong answer — two seams of three — for `backings.test.ts`. */
export function createCloudBackings() {
  return {
    sandbox: createFakeSandboxBackend(),
    keyring: createLocalKeyring("fake-cloud-secret-that-is-long-enough-32"),
  };
}
