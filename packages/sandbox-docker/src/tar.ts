import { posix } from "node:path";
import { Readable } from "node:stream";

import type { SandboxFile } from "@graft/sandbox/types";
import { extract, pack } from "tar-stream";

/**
 * Files in and out of a container ride the archive endpoints as tar streams, which is `docker cp`
 * without the CLI. `tar-stream` does the header arithmetic; long paths get PAX headers from it, and
 * Docker's Go archiver writes the same for what it hands back.
 */

export type TarOwner = { uid: number; gid: number };

/**
 * A tar of `files`, paths relative, with an explicit entry for every directory in between. The
 * directory entries are the point: the daemon extracts as root and creates a missing parent as root
 * too, so without them the sandbox user could read what was written but not write beside it.
 */
export function packTree(files: SandboxFile[], owner: TarOwner): Readable {
  const archive = pack();
  const directories = new Set<string>();
  for (const file of files) {
    let dir = posix.dirname(file.path);
    while (dir !== "." && dir !== "/" && dir !== "") {
      directories.add(dir);
      dir = posix.dirname(dir);
    }
  }
  const mtime = new Date();
  for (const dir of [...directories].sort()) {
    archive.entry({ name: `${dir}/`, type: "directory", mode: 0o755, mtime, ...owner });
  }
  for (const file of files) {
    archive.entry({ name: file.path, type: "file", mode: 0o644, mtime, ...owner }, file.content);
  }
  archive.finalize();
  // `tar-stream` builds on streamx, whose streams are async-iterable but not Node's `Readable`;
  // wrapping gives the HTTP request the `pipe` it expects.
  return Readable.from(archive);
}

export type TarEntry = { path: string; type: string; content: Buffer };

/** Every entry of a tar stream, read in full. */
export function readTar(stream: Readable): Promise<TarEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: TarEntry[] = [];
    const extractor = extract();
    extractor.on("entry", (header, body, next) => {
      const chunks: Buffer[] = [];
      body.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
      body.on("end", () => {
        entries.push({
          path: header.name,
          type: header.type ?? "file",
          content: Buffer.concat(chunks),
        });
        next();
      });
      body.on("error", reject);
      body.resume();
    });
    extractor.on("finish", () => resolve(entries));
    extractor.on("error", reject);
    stream.on("error", reject);
    stream.pipe(extractor);
  });
}

/**
 * The files of an archive the daemon returned for a directory, as `downloadDirectory` promises them:
 * the directory's own name stripped from the front, paths relative, sorted. The daemon names the
 * top-level entry after the last segment of the path it was asked for.
 */
export function filesUnder(entries: TarEntry[]): SandboxFile[] {
  return entries
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      path: entry.path.replace(/^\.?\/?[^/]+\//, ""),
      content: entry.content.toString("utf8"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
