import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assertBlobName, createFilesystemBlobStore } from "./blob-store";
import { blobStoreConformance } from "./conformance";
import { createFilesystemToolboxStore } from "./filesystem";
import { BLOB_TMP_SUFFIX } from "./layout";

/**
 * The filesystem backing of the blob store: the conformance suite, then what is true of a directory
 * alone — that the blobs tree sits beside the toolboxes under one root, which is what lets a sandbox
 * mount `<root>/.blobs/<agentId>` at `/blobs` and this store see the same files.
 */

blobStoreConformance("filesystem", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-blob-store-"));
  const store = createFilesystemBlobStore({ root });
  return {
    store,
    // The runner's write, done by hand: files under `<root>/.blobs/<agentId>/<name>/`.
    write: async (agentId, name, files) => {
      for (const file of files) {
        const target = join(store.agentRoot(agentId), name, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
});

describe("the filesystem blob store", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-blob-store-fs-"));
  const blobs = createFilesystemBlobStore({ root });
  const toolboxes = createFilesystemToolboxStore({ root });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it("puts an agent's blobs under <root>/.blobs/<agentId>, beside the toolboxes the toolbox store writes under the same root", async () => {
    await toolboxes.writeTree("person-1", "tools/acme/list/v1", [
      { path: "index.ts", content: "" },
    ]);
    await mkdir(join(blobs.agentRoot("agent-1"), "blob-1"), { recursive: true });
    await writeFile(join(blobs.agentRoot("agent-1"), "blob-1", "meta.json"), "{}", "utf8");

    expect(blobs.root).toBe(root);
    expect(blobs.agentRoot("agent-1")).toBe(join(root, ".blobs", "agent-1"));
    expect((await readdir(root)).sort()).toEqual([".blobs", "person-1"]);
    expect(await blobs.readMeta("agent-1", "blob-1")).toBe("{}");
    // The toolbox store cannot reach the blobs tree: `.blobs` is not a legal toolbox id.
    await expect(toolboxes.exists(".blobs", "agent-1")).rejects.toThrow(/toolbox id/);
  });

  it("resolves a relative root against the working directory, as the toolbox store does", () => {
    const relative = createFilesystemBlobStore({ root: "./.graft/toolboxes" });
    expect(relative.root).toBe(join(process.cwd(), ".graft", "toolboxes"));
  });

  it("takes a blob id or a blob id with the .tmp suffix as a name, and nothing that could be a path", () => {
    expect(() => assertBlobName("6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d")).not.toThrow();
    expect(() =>
      assertBlobName(`6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d${BLOB_TMP_SUFFIX}`),
    ).not.toThrow();
    for (const bad of ["", BLOB_TMP_SUFFIX, "..", `..${BLOB_TMP_SUFFIX}`, "a/b", "a/b.tmp", "/a"]) {
      expect(() => assertBlobName(bad), bad).toThrow(/blob id/);
    }
  });
});
