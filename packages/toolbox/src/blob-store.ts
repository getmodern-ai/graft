import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  agentBlobsPath,
  assertAgentId,
  assertBlobId,
  BLOB_DATA_FILE,
  BLOB_META_FILE,
  BLOB_TMP_SUFFIX,
  BLOBS_ROOT,
  blobPath,
} from "./layout";
import type { BlobDirectoryStat, BlobStore } from "./types";

/**
 * The blob store as directories on this machine, under the same root the filesystem toolbox store
 * writes toolboxes to: `<root>/.blobs/<agentId>/<blobId>/` (ADR 0023; the layout is `./layout.ts`).
 * `root` is `GRAFT_TOOLBOX_ROOT` in the server, so a sandbox that mounts `<root>/.blobs/<agentId>`
 * at `/blobs` and this store see one tree, as the toolbox store and the `/tools` mount do
 * (`./filesystem.ts` says how the two meet; the blobs directory meets a sandbox the same way,
 * `packages/sandbox-docker`'s `mountToolbox` with `blobs`).
 *
 * This store never writes a blob: the runner does, inside the sandbox, into `<blobId>.tmp` and then
 * by rename (GRA-186). What the server needs of a blob is to see it, read its sidecar, tell how
 * old a directory is and remove it when the sweep says so (GRA-189), and to know which agents have
 * a directory at all (GRA-195), and those are the six verbs.
 *
 * **What the sandbox wrote is untrusted input here.** ADR 0023's "the scope is a mount" paragraph
 * makes the mount the guarantee for code running *inside* the sandbox; this store reads the same
 * tree from outside, where no mount narrows it, so a symlink authored or vendored code dropped at
 * `/blobs/<id>` or `/blobs/<id>/meta.json` would otherwise lead the server into another agent's
 * directory or any readable host file. Every entry touched is `lstat`ed and refused if it is a
 * symlink, and what is read or removed has to resolve beneath the agent's real directory; `list`
 * answers only names the store can act on, and skips the rest.
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

    listAgents: async () => {
      const entries = await readdir(join(root, BLOBS_ROOT), { withFileTypes: true }).catch(
        (error: unknown) => {
          // No `.blobs/` yet is no agents: the first blob any run writes makes it.
          if ((error as { code?: unknown }).code === "ENOENT") return [];
          throw error;
        },
      );
      // As `list` below: a symlink is not a directory to `Dirent`, and a name that is not an agent id
      // is one no other verb would accept, so both are skipped rather than handed to a caller that
      // could do nothing with them.
      return entries
        .filter((entry) => entry.isDirectory() && isAgentName(entry.name))
        .map((entry) => entry.name)
        .sort();
    },

    list: async (agentId) => {
      const dir = agentRoot(agentId);
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
        // No directory yet is no blobs: a run's first write makes it, and the sweep asks about every
        // agent, most of which have written none.
        if ((error as { code?: unknown }).code === "ENOENT") return [];
        throw error;
      });
      // `Dirent.isDirectory()` does not follow a link, so a symlink is skipped here whatever it
      // points at; a directory under a name that is not a blob id or a `.tmp` is skipped too, since
      // `remove` refuses it and a listing a caller cannot act on is a listing that breaks the caller.
      return entries
        .filter((entry) => entry.isDirectory() && isBlobName(entry.name))
        .map((entry) => entry.name)
        .sort();
    },

    readMeta: async (agentId, blobId) => {
      const dir = blobDir(agentId, blobId);
      const file = join(dir, BLOB_META_FILE);
      const directory = await inspect(dir, `blob ${blobId} of agent ${agentId}`);
      const sidecar = directory?.isDirectory()
        ? await inspect(file, `the sidecar of blob ${blobId} of agent ${agentId}`)
        : null;
      // Confirmed absent (no directory, or no sidecar in it) is null; a link was already refused
      // by `inspect`, and a read that fails for any other reason rejects as itself.
      if (!sidecar?.isFile()) return null;
      await assertBeneath(agentRoot(agentId), file);
      return readFile(file, "utf8");
    },

    exists: async (agentId, blobId) => {
      const info = await inspect(blobDir(agentId, blobId), `blob ${blobId} of agent ${agentId}`);
      return info?.isDirectory() ?? false;
    },

    remove: async (agentId, name) => {
      assertAgentId(agentId);
      assertBlobName(name);
      const target = join(agentRoot(agentId), name);
      // Refused rather than unlinked: `rm` on a link would remove the link alone and leave what it
      // pointed at, but a link here is a sandbox reaching for something, and the store does not act
      // on it either way.
      const info = await inspect(target, `${name} of agent ${agentId}`);
      if (info === null) return;
      await assertBeneath(agentRoot(agentId), target);
      await rm(target, { recursive: true, force: true });
    },

    stat: async (agentId, name): Promise<BlobDirectoryStat | null> => {
      assertAgentId(agentId);
      assertBlobName(name);
      const dir = join(agentRoot(agentId), name);
      const directory = await inspect(dir, `${name} of agent ${agentId}`);
      if (!directory?.isDirectory()) return null;
      await assertBeneath(agentRoot(agentId), dir);
      const [data, meta] = await Promise.all([
        inspect(join(dir, BLOB_DATA_FILE), `the data of ${name} of agent ${agentId}`),
        inspect(join(dir, BLOB_META_FILE), `the sidecar of ${name} of agent ${agentId}`),
      ]);
      // The newest of the three: a directory's own mtime moves when an entry lands in it, `data`'s
      // on every chunk the runner streams, so a write in progress is never read as old.
      const moments = [directory, data, meta]
        .filter((info): info is Stats => info !== null)
        .map((info) => info.mtimeMs);
      return {
        lastWrittenAt: new Date(Math.max(...moments)),
        bytes: data?.isFile() ? data.size : null,
      };
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

function isBlobName(name: string): boolean {
  try {
    assertBlobName(name);
    return true;
  } catch {
    return false;
  }
}

function isAgentName(name: string): boolean {
  try {
    assertAgentId(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * `lstat`, so a link is seen as a link and never followed: null when nothing is there, a refusal
 * naming the entry when it is a symlink, the entry's own info otherwise.
 */
async function inspect(path: string, what: string): Promise<Stats | null> {
  const info = await lstat(path).catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    throw new Error(
      `${what} is a symlink, which the blob store does not follow: a sandbox may write only real files under /blobs (ADR 0023)`,
    );
  }
  return info;
}

/**
 * Throw unless `path`, as the filesystem resolves it, is under the agent's directory as the
 * filesystem resolves that. The `lstat` above catches a link at the entry itself; this catches
 * anything else that would carry a read or a remove out of the agent's own directory.
 */
async function assertBeneath(agentDir: string, path: string): Promise<void> {
  const [realAgentDir, real] = await Promise.all([realpath(agentDir), realpath(path)]);
  if (real !== realAgentDir && !real.startsWith(`${realAgentDir}${sep}`)) {
    throw new Error(
      `${path} resolves outside the agent's blobs directory (ADR 0023): ${real} is not under ${realAgentDir}`,
    );
  }
}
