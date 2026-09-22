import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  agentBlobsPath,
  assertAgentId,
  assertBlobId,
  BLOB_META_FILE,
  BLOB_TMP_SUFFIX,
  blobPath,
} from "./layout";
import type { BlobStore } from "./types";

/**
 * The blob store as directories on this machine, under the same root the filesystem toolbox store
 * writes toolboxes to: `<root>/.blobs/<agentId>/<blobId>/` (ADR 0023; the layout is `./layout.ts`).
 * `root` is `GRAFT_TOOLBOX_ROOT` in the server, so a sandbox that mounts `<root>/.blobs/<agentId>`
 * at `/blobs` and this store see one tree, as the toolbox store and the `/tools` mount do
 * (`./filesystem.ts` says how the two meet; the blobs directory meets a sandbox the same way,
 * `packages/sandbox-docker`'s `mountToolbox` with `blobs`).
 *
 * This store never writes a blob: the runner does, inside the sandbox, into `<blobId>.tmp` and then
 * by rename (GRA-186). What the server needs of a blob is to see it, read its sidecar and remove it
 * when the sweep says so (GRA-189), and those are the four verbs.
 */
export type FilesystemBlobStore = BlobStore & {
  /** The absolute root the blobs tree lives under; `<root>/.blobs/<agentId>` is one agent's. */
  readonly root: string;
  /** The absolute directory of one agent's blobs, whether or not anything has made it yet. */
  agentRoot(agentId: string): string;
};

export function createFilesystemBlobStore(options: { root: string }): FilesystemBlobStore {
  const root = resolve(options.root);
  const agentRoot = (agentId: string) => join(root, ...agentBlobsPath(agentId).split("/"));
  const blobDir = (agentId: string, blobId: string) =>
    join(root, ...blobPath(agentId, blobId).split("/"));

  return {
    root,
    agentRoot,

    list: async (agentId) => {
      const dir = agentRoot(agentId);
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
        // No directory yet is no blobs: a run's first write makes it, and the sweep asks about every
        // agent, most of which have written none.
        if ((error as { code?: unknown }).code === "ENOENT") return [];
        throw error;
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },

    readMeta: async (agentId, blobId) => {
      const file = join(blobDir(agentId, blobId), BLOB_META_FILE);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new Error(`no such blob for agent ${agentId}: ${blobId}`);
      return readFile(file, "utf8");
    },

    exists: async (agentId, blobId) => {
      const info = await stat(blobDir(agentId, blobId)).catch(() => null);
      return info?.isDirectory() ?? false;
    },

    remove: async (agentId, name) => {
      assertAgentId(agentId);
      assertBlobName(name);
      await rm(join(agentRoot(agentId), name), { recursive: true, force: true });
    },
  };
}

/**
 * A blob id, or a blob id with `BLOB_TMP_SUFFIX` — the two directory names an agent's blobs
 * directory holds. The id rule alone already refuses a slash, an empty name and `..`; taking the
 * suffix off first is what keeps the rule the same for both forms rather than letting `.tmp` widen
 * what an id may look like.
 */
export function assertBlobName(name: string): void {
  const id = name.endsWith(BLOB_TMP_SUFFIX) ? name.slice(0, -BLOB_TMP_SUFFIX.length) : name;
  assertBlobId(id);
}
