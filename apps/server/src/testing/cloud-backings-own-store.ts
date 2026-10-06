import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import {
  createFilesystemBlobStore,
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
} from "@graft/toolbox";
import { createLocalKeyring } from "@graft/vault";

import type { CloudBackings } from "../backings";

/**
 * A module shaped like the private package's entry from GRA-39 on, for `backings.test.ts`: it
 * answers with a toolbox store of its own — here a filesystem store in a directory of its own, with
 * one file already in it, so the test can tell the two stores apart by reading it back — which the
 * selector must use in place of the store it built at the toolbox root. Since GRA-185 it answers a
 * blob store of its own the same way, with one sidecar already in it (GRA-192's shape). Async, as
 * the real factory may be.
 */
export async function createCloudBackings(): Promise<CloudBackings> {
  const root = mkdtempSync(join(tmpdir(), "graft-own-store-"));
  const store = createFilesystemToolboxStore({ root });
  await store.writeTree("person1", "tools/own/marker/v1", [
    { path: "marker.txt", content: "written by the factory's own store" },
  ]);
  const blobStore = createFilesystemBlobStore({ root });
  await mkdir(join(blobStore.agentRoot("agent1"), "own-blob"), { recursive: true });
  await writeFile(
    join(blobStore.agentRoot("agent1"), "own-blob", "meta.json"),
    '{"marker":"written by the factory\'s own blob store"}',
    "utf8",
  );
  return {
    sandbox: createFakeSandboxBackend(),
    keyring: { ...createLocalKeyring("fake-cloud-secret-that-is-long-enough-32"), id: "own-store" },
    mirror: createNoopToolboxMirror(),
    store,
    blobStore,
  };
}
