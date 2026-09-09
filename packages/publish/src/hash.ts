import { createHash } from "node:crypto";

import type { ToolboxFile } from "@graft/toolbox";

/** SHA-256 of a text, hex. What `tool_version.lockfile_hash` holds. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One hash over a module's files — what `tool_version.source_hash` holds, so two versions with the
 * same code are recognisable (a republish that changed nothing, a tool rebuilt from the same draft).
 * Sorted by path so the order files were read in cannot change the hash, and each file framed by its
 * path and its byte length so two files cannot be spliced into one reading.
 */
export function sourceHashOf(files: readonly ToolboxFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\n${Buffer.byteLength(file.content, "utf8")}\n`, "utf8");
    hash.update(file.content, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}
