/**
 * The toolbox storage seam: where a person's authored tools live as files (CONTEXT.md, "Toolbox").
 *
 * ADR 0002 gives every seam exactly two backings behind one interface. This file is the interface;
 * `./filesystem.ts` is the backing this repository holds — a directory per toolbox under a configured
 * root — and the hosted form is the same directory mirrored to S3 by a `ToolboxMirror` in the private
 * package (GRA-20). Nothing below is shaped like either: no bucket, no region, no volume name. A
 * caller sees a toolbox id, a relative path and files.
 *
 * Two facts about the layout are the store's to enforce, the rest is `./layout.ts`'s to describe:
 *
 *  - **Nothing under `tools/` is ever removed** (ADR 0009). `remove` accepts a draft path and refuses
 *    everything else, so a bug in a caller cannot delete a version; a republish writes the next
 *    version directory beside the old one, and the old one stays.
 *  - **A toolbox id and every path are validated before they touch a filesystem.** The id is the same
 *    shape the sandbox seam takes for a toolbox (`assertSandboxName`), because the same id names the
 *    directory here and the volume a sandbox mounts, and the two must agree on what an id may be.
 *
 * Copied in shape from the sandbox seam's file verbs rather than from Cando's toolbox code, which
 * reached the toolbox only through a sandbox (ADR 0011): here the server holds the toolbox directly
 * and a sandbox sees the same tree as a mount (`./filesystem.ts` says how the two meet).
 */

/** A file as the store reads and writes it: a path relative to the directory asked about, and its text. */
export type ToolboxFile = { path: string; content: string };

export type ToolboxStore = {
  /**
   * Every file under `path`, recursively, paths relative to `path` and sorted — the shape `writeTree`
   * takes and the check reads (`readModuleSources`). Text: a module is text, and so is everything the
   * publish reads through this verb (a draft, a lockfile). A version's `node_modules` may hold
   * binaries; read one file of it with `read`, or the tree as an operator, never as a module. Rejects
   * when the path is not a directory in the toolbox — `exists` is the question to ask first.
   */
  readTree(toolboxId: string, path: string): Promise<ToolboxFile[]>;
  /**
   * Write files under `path`, creating directories as needed; a file already there with the same
   * name is overwritten and files not named are left. Paths in `files` are relative to `path`.
   */
  writeTree(toolboxId: string, path: string, files: readonly ToolboxFile[]): Promise<void>;
  /** One file as text. Rejects when the path is not a file in the toolbox. */
  read(toolboxId: string, path: string): Promise<string>;
  /** The names directly under a directory, sorted. Rejects when the path is not a directory. */
  list(toolboxId: string, path: string): Promise<string[]>;
  /** Whether anything — file or directory — is at the path. */
  exists(toolboxId: string, path: string): Promise<boolean>;
  /**
   * Remove a draft directory and everything under it. A path outside `.drafts/` is refused before
   * anything is touched (ADR 0009: nothing in the toolbox is deleted by the system), and a draft that
   * is already gone is not an error. A blob is not a draft and is not in a toolbox: removing one is
   * `BlobStore.remove`, the seam beside this one.
   */
  remove(toolboxId: string, path: string): Promise<void>;
};

/**
 * The blob store seam: where an agent's blobs live between the tool that wrote one and the tool
 * that reads it (CONTEXT.md, "Blob store"; ADR 0023). A seam beside the toolbox store, not a
 * widening of it: `ToolboxStore.remove` still accepts a draft and nothing else, and a blob past its
 * time is the one thing the system deletes. Keyed by agent, because the scope is the agent's mount
 * (`.blobs/<agentId>` mounted alone at `/blobs`, `./layout.ts`); a blob id or a `.tmp` name is the
 * other half. `./blob-store.ts` is the backing this repository holds, the `.blobs` tree beside the
 * toolboxes under the same root; the hosted form's is the private package's (GRA-192).
 *
 * Reads and removes only. The runner writes a blob from inside the sandbox (GRA-186), where the
 * server's store is not; what the server needs of a blob is to see it, read its sidecar and remove
 * it when the sweep says so (GRA-189).
 */
export type BlobStore = {
  /**
   * The directory names under the agent's blobs directory that are a blob id or a `<blobId>.tmp` a
   * killed run left half-written, sorted. An agent with no directory yet has no blobs, not an error.
   * Anything else a sandbox wrote there (a directory under a foreign name, a file, a symlink) is
   * skipped, left in place and never removed by the store: `remove` takes only the two names, and
   * the sweep deletes only what it can name (ADR 0023).
   */
  list(agentId: string): Promise<string[]>;
  /**
   * The text of a blob's `meta.json`, or null when the blob, or its sidecar, is confirmed not to be
   * there. The null is the store's own not-found signal and the only one: anything else that stops
   * the read (a symlink at the directory or the sidecar, since the tree is sandbox-writable and the
   * store follows no link out of the agent's directory, ADR 0023 "the scope is a mount"; a
   * permission or a backing error) rejects, so a caller deciding on a missing sidecar (the sweep's
   * `remove_orphan`, GRA-189) never mistakes a failed read for an absent file.
   */
  readMeta(agentId: string, blobId: string): Promise<string | null>;
  /** Whether the blob's directory is there. A `.tmp` directory is not yet a blob; a symlink is refused. */
  exists(agentId: string, blobId: string): Promise<boolean>;
  /**
   * Remove one blob's directory, or one `<blobId>.tmp`, and everything in it; one already gone is
   * not an error. `name` is a blob id, or a blob id with `BLOB_TMP_SUFFIX`, and nothing else: a
   * slash, `..` or an empty name is refused before anything is touched, and a symlink under a legal
   * name is refused and left as it is, so nothing outside the agent's own directory is reachable
   * through this verb.
   */
  remove(agentId: string, name: string): Promise<void>;
  /**
   * When a directory under the agent's blobs directory was last written to, and how many bytes its
   * `data` holds; null when nothing is there. `name` is a blob id or a `<blobId>.tmp`, as `remove`
   * takes. The sweep's two reads past the sidecar (GRA-189): whether a `.tmp` is a write still
   * landing or one a killed run abandoned, and what a committed directory it found no row and no
   * readable sidecar for held. `lastWrittenAt` is the newest modification time among the directory,
   * `data` and `meta.json`, so a write still streaming into `data` reads as now; `bytes` is null
   * when there is no `data` yet. A symlink at any of the three is refused, as everywhere here.
   */
  stat(agentId: string, name: string): Promise<BlobDirectoryStat | null>;
};

/** What `BlobStore.stat` answers for a directory that is there. */
export type BlobDirectoryStat = {
  /** The newest of the directory's, `data`'s and `meta.json`'s modification times. */
  lastWrittenAt: Date;
  /** The size of `data`, or null when the directory holds none yet. */
  bytes: number | null;
};

/**
 * The off-site copy of a published version. Called by the publish after the version directory is
 * written and the pointer moved, never awaited by it and never on its path: a failure is the
 * mirror's to report, and the toolbox copy is what runs (GRA-1, "the S3 mirror in the hosted form
 * is asynchronous and best-effort"). The backing in this repository records the call and copies
 * nothing (`./mirror.ts`); the S3 mirror is the private package's (GRA-20). The interface carries
 * ids and a path — the mirror reads the directory itself, which is what "the same directory
 * mirrored" means (ADR 0002).
 */
export type ToolboxMirror = {
  mirrorVersion(toolboxId: string, versionPath: string): Promise<void>;
};
