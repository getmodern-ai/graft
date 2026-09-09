import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { assertSandboxName } from "@graft/sandbox/types";

import { assertToolboxPath, isDraftPath } from "./layout";
import type { ToolboxFile, ToolboxStore } from "./types";

/**
 * The toolbox as a directory tree on this machine: `<root>/<toolboxId>/<path>` (ADR 0002's
 * self-hosted backing). `root` is `GRAFT_TOOLBOX_ROOT` in the server; a test hands the fake sandbox's
 * `toolboxRoot(id)` parent so the store and the sandbox see one tree.
 *
 * **How this tree and a sandbox meet.** A sandbox mounts a toolbox by id (`mountToolbox`) and sees it
 * at `/tools`; the Docker backing mounts a named volume per toolbox id. For the server's store and
 * the sandbox's mount to be the same files, that volume has to be backed by `<root>/<toolboxId>`,
 * which is what `@graft/sandbox-docker`'s `toolboxHostRoot` option does: point it at this store's
 * root, and every toolbox volume is a bind of the directory this store writes. The publish then
 * writes a version here, the install step reads it through the volume and writes `node_modules`
 * beside it, and a run mounts the same directory again. The fake sandbox does the same with a
 * symlink, which is why a service test builds this store over the fake's root. The compose file
 * (GRA-33) has to mount the same host directory into the server container at the same path, since
 * the bind's device path is read by the daemon, not by the server.
 *
 * Ownership follows from that: files the server writes belong to the server's user, files a sandbox
 * writes belong to the sandbox user (`graft`, 10001) after the backing's chown. Both are
 * world-readable, so each side reads the other's; the server can remove a draft the sandbox wrote
 * only when its user may write the draft's directories, which the self-hosted image arranges by
 * running the server as that user (GRA-33).
 */
export type FilesystemToolboxStore = ToolboxStore & {
  /** The absolute root every toolbox lives under. */
  readonly root: string;
  /** The absolute directory of one toolbox — `<root>/<toolboxId>` — created on first write. */
  toolboxRoot(toolboxId: string): string;
};

export function createFilesystemToolboxStore(options: { root: string }): FilesystemToolboxStore {
  const root = resolve(options.root);
  const toolboxRoot = (toolboxId: string) => {
    assertSandboxName("a toolbox id", toolboxId);
    return join(root, toolboxId);
  };
  /** The host path of a toolbox-relative path, both halves validated. */
  const hostPath = (toolboxId: string, path: string, allowRoot = false) => {
    assertToolboxPath(path, { allowRoot });
    return path === "" ? toolboxRoot(toolboxId) : join(toolboxRoot(toolboxId), ...path.split("/"));
  };

  return {
    root,
    toolboxRoot,

    readTree: async (toolboxId, path) => {
      const dir = hostPath(toolboxId, path, true);
      await assertDirectory(dir, path);
      return walk(dir);
    },

    writeTree: async (toolboxId, path, files) => {
      const dir = hostPath(toolboxId, path);
      for (const file of files) assertToolboxPath(file.path);
      await mkdir(dir, { recursive: true });
      for (const file of files) {
        const target = join(dir, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
    },

    read: async (toolboxId, path) => {
      const file = hostPath(toolboxId, path);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new Error(`no such file in the toolbox: ${path}`);
      return readFile(file, "utf8");
    },

    list: async (toolboxId, path) => {
      const dir = hostPath(toolboxId, path, true);
      await assertDirectory(dir, path);
      return (await readdir(dir)).sort();
    },

    exists: async (toolboxId, path) => {
      const target = hostPath(toolboxId, path, true);
      return (await stat(target).catch(() => null)) !== null;
    },

    remove: async (toolboxId, path) => {
      const target = hostPath(toolboxId, path);
      if (!isDraftPath(path)) {
        throw new Error(
          `only a draft may be removed from the toolbox, never a version (ADR 0009): ${path}`,
        );
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}

async function assertDirectory(dir: string, path: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`no such directory in the toolbox: ${path === "" ? "(root)" : path}`);
  }
}

/** Every file under `dir`, recursively, with paths relative to it and sorted — `ToolboxStore.readTree`. */
async function walk(dir: string, relative = ""): Promise<ToolboxFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ToolboxFile[] = [];
  for (const entry of entries) {
    const path = relative ? posix.join(relative, entry.name) : entry.name;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute, path)));
    } else if (entry.isFile()) {
      files.push({ path, content: await readFile(absolute, "utf8") });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
