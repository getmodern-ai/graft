import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { createLocalKeyring } from "@graft/vault";

import type { CloudBackings } from "../backings";

/**
 * A module shaped like the private package's entry from GRA-39 on, for `backings.test.ts`: it
 * answers with a toolbox store of its own — here a filesystem store in a directory of its own, with
 * one file already in it, so the test can tell the two stores apart by reading it back — which the
 * selector must use in place of the store it built at the toolbox root. Async, as the real factory
 * may be.
 */
export async function createCloudBackings(): Promise<CloudBackings> {
  const store = createFilesystemToolboxStore({
    root: mkdtempSync(join(tmpdir(), "graft-own-store-")),
  });
  await store.writeTree("person1", "tools/own/marker/v1", [
    { path: "marker.txt", content: "written by the factory's own store" },
  ]);
  return {
    sandbox: createFakeSandboxBackend(),
    keyring: { ...createLocalKeyring("fake-cloud-secret-that-is-long-enough-32"), id: "own-store" },
    mirror: createNoopToolboxMirror(),
    store,
  };
}
