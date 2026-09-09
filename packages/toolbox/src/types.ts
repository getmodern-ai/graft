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
   * is already gone is not an error.
   */
  remove(toolboxId: string, path: string): Promise<void>;
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
