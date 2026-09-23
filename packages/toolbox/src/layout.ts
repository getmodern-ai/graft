import { assertSandboxName } from "@graft/sandbox/types";

/**
 * The layout of one person's toolbox, as paths relative to its root (GRA-1, "The check, the runner
 * and the toolbox"): published versions under vendor and tool name, drafts under a job-scoped path.
 *
 *   tools/<vendor>/<name>/v<N>/     one published version: the module's files, and when it declares
 *                                   dependencies its own node_modules and package-lock.json
 *   .drafts/<jobId>/                what an acquire job is writing before it publishes
 *
 * A version directory is named by its number, and the number is the tool's next (`@graft/core`'s
 * `nextVersionNumber`), so a republish lands beside the last version and never on it (ADR 0009). The
 * `tool_version.path` column holds exactly what `versionPath` returns; inside a sandbox the same
 * directory is under `TOOLBOX_MOUNT_PATH`, which is what `sandboxPath` prepends.
 *
 * Beside the toolboxes, not inside one, the blobs (ADR 0023, GRA-185): relative to the toolbox
 * *root*, the directory every toolbox is a subdirectory of,
 *
 *   .blobs/<agentId>/<blobId>/      one blob: its `data` and its `meta.json` sidecar
 *   .blobs/<agentId>/<blobId>.tmp/  the same blob while the runner is still writing it
 *
 * The scope is a mount: an agent's sandbox mounts `.blobs/<agentId>` alone at `BLOBS_MOUNT_PATH`,
 * the way it mounts the person's toolbox at `TOOLBOX_MOUNT_PATH`, so another agent's blobs are on no
 * path it can name. No toolbox can be called `.blobs`, since a toolbox id starts with a letter or a
 * digit (`assertSandboxName`), which is what keeps the two trees apart under one root.
 */

/** Where a sandbox mounts the toolbox — the path the Docker image owns for the sandbox user. */
export const TOOLBOX_MOUNT_PATH = "/tools";

/** The published half of the toolbox: `tools/<vendor>/<name>/v<N>`. */
export const PUBLISHED_DIR = "tools";

/** The drafts half: `.drafts/<jobId>`. The one subtree `ToolboxStore.remove` accepts. */
export const DRAFTS_DIR = ".drafts";

/** The directory of one published version, relative to the toolbox root. */
export function versionPath(vendor: string, name: string, versionNumber: number): string {
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new Error(`a version number is a positive integer: ${JSON.stringify(versionNumber)}`);
  }
  return `${toolPath(vendor, name)}/v${versionNumber}`;
}

/** The directory holding every version of one tool, relative to the toolbox root. */
export function toolPath(vendor: string, name: string): string {
  assertSegment("a vendor slug", vendor);
  assertSegment("a tool name", name);
  return `${PUBLISHED_DIR}/${vendor}/${name}`;
}

/** The draft directory of one acquire job, relative to the toolbox root. */
export function draftPath(jobId: string): string {
  assertSegment("a job id", jobId);
  return `${DRAFTS_DIR}/${jobId}`;
}

/** Whether a toolbox-relative path is a draft or inside one — what `remove` may touch. */
export function isDraftPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length >= 2 && segments[0] === DRAFTS_DIR && segments[1] !== "";
}

/** The same path as a process inside a sandbox sees it. */
export function sandboxPath(toolboxPath: string): string {
  assertToolboxPath(toolboxPath, { allowRoot: true });
  return toolboxPath === "" ? TOOLBOX_MOUNT_PATH : `${TOOLBOX_MOUNT_PATH}/${toolboxPath}`;
}

/**
 * The toolbox a person's tools live in. One toolbox per person (ADR 0007), so the id is the person's
 * id, and the same id names the sandbox volume (`SandboxHandle.mountToolbox`). Asserted rather than
 * transformed: an id that is not a legal volume name is a bug in whoever minted it, not a value to
 * quietly hash into one.
 */
export function toolboxIdOf(personId: string): string {
  assertSandboxName("a toolbox id", personId);
  return personId;
}

/** The blobs tree, relative to the toolbox root and beside every toolbox: `.blobs/<agentId>/<blobId>`. */
export const BLOBS_ROOT = ".blobs";

/** Where a sandbox mounts its agent's blobs directory alone (ADR 0023: the scope is the mount). */
export const BLOBS_MOUNT_PATH = "/blobs";

/**
 * The suffix of a blob's directory while it is being written: `<blobId>.tmp` beside where
 * `<blobId>` will be, renamed whole once `data` and `meta.json` are in it, so a reader sees a blob
 * complete or not at all. Two copies exist and both are pinned to this one (GRA-186, GRA-189,
 * GRA-199): the runner's, since `runner.mjs` ships to the sandbox alone
 * (`packages/mcp/src/run.test.ts`), and `@graft/core`'s sweep decision's, since that package does
 * not depend on this one (`packages/mcp/src/sweep.test.ts`).
 */
export const BLOB_TMP_SUFFIX = ".tmp";

/** The two files in a blob's directory: the bytes, and the sidecar the sweep reads (`BlobStore.readMeta`). */
export const BLOB_DATA_FILE = "data";
export const BLOB_META_FILE = "meta.json";

/** Throw unless `agentId` can name a directory: the segment rule every other id here is held to. */
export function assertAgentId(agentId: string): void {
  assertSegment("an agent id", agentId);
}

/** Throw unless `blobId` can name a directory. The id inside a `blob://<id>` ref is checked with this. */
export function assertBlobId(blobId: string): void {
  assertSegment("a blob id", blobId);
}

/**
 * One agent's blobs directory, relative to the toolbox root: `.blobs/<agentId>`. What the agent's
 * sandbox mounts at `BLOBS_MOUNT_PATH`, and the one directory `BlobStore` reads and removes under.
 */
export function agentBlobsPath(agentId: string): string {
  assertAgentId(agentId);
  return `${BLOBS_ROOT}/${agentId}`;
}

/** One blob's directory, relative to the toolbox root: `.blobs/<agentId>/<blobId>`. */
export function blobPath(agentId: string, blobId: string): string {
  assertBlobId(blobId);
  return `${agentBlobsPath(agentId)}/${blobId}`;
}

/**
 * The same blob as a process inside its agent's sandbox sees it: `/blobs/<blobId>`. No agent id,
 * because the mount already is the agent's; a ref names the id and nothing else (ADR 0023).
 */
export function blobSandboxPath(blobId: string): string {
  assertBlobId(blobId);
  return `${BLOBS_MOUNT_PATH}/${blobId}`;
}

/** One path segment (a vendor slug, a tool name, a job id, an agent id, a blob id) as a directory name: nothing that could be a path. */
function assertSegment(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new Error(
      `${kind} must be 1-128 letters, digits, '.', '_' or '-' and start with a letter or digit: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Throw unless `path` is relative and stays inside the toolbox: no leading `/`, no empty, `.` or `..`
 * segment, no backslash or NUL. The empty path names the toolbox root and is accepted only where a
 * caller says so — a read may ask about the root, a write and a remove may not.
 */
export function assertToolboxPath(path: string, options: { allowRoot?: boolean } = {}): void {
  if (path === "") {
    if (options.allowRoot) return;
    throw new Error("a toolbox path names something inside the toolbox, not the toolbox itself");
  }
  if (path.startsWith("/") || /[\\\0]/.test(path)) {
    throw new Error(`a toolbox path is relative, with forward slashes: ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`a toolbox path has no empty, '.' or '..' segments: ${JSON.stringify(path)}`);
    }
  }
}
