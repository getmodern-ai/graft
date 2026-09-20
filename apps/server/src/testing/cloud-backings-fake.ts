import type { ConnectionProvider } from "@graft/core";
import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { createLocalKeyring } from "@graft/vault";

import type { CloudBackings, CloudBackingsInput } from "../backings";

/**
 * A module shaped like the private package's entry, for `backings.test.ts`: the selector imports it
 * by path where it would import `@graft/cloud-backings`, and the test asserts what came back. The
 * mirror here writes what it was handed into the store it was handed, which is how the test sees
 * that the input reached the factory without the two sharing any state. The provider it answers is
 * a link provider covering one vendor (ADR 0019), so the test sees the keyring appended after it.
 */
export const fakeCloudProvider: ConnectionProvider = {
  name: "fake-broker",
  connect: {
    kind: "link",
    scheme: "relay",
    target: async (vendor) => (vendor === "gmail" ? "gmail" : null),
    start: async () => ({ url: "https://fake-broker.example/link", expiresAt: new Date(0) }),
    complete: async () => ({ ok: true, ref: "acct_fake", label: null }),
  },
  covers: async (vendor) => vendor === "gmail",
  resolve: () => ({ mode: "inject", scheme: null, schemeConfig: {}, credentialCiphertext: null }),
  revoke: async () => undefined,
};

export function createCloudBackings(input: CloudBackingsInput): CloudBackings {
  const keyring = createLocalKeyring("fake-cloud-secret-that-is-long-enough-32");
  return {
    providers: [fakeCloudProvider],
    // The hosted form's mail transport (ADR 0021): records nothing, answers the shared shape.
    mail: { name: "fake-mail", send: async () => ({ delivered: true, transport: "fake-mail" }) },
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
