import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

  it("follows no symlink a sandbox left in the tree: skipped by list, refused by readMeta, exists and remove, and the link and its target are left as they are (ADR 0023)", async () => {
    // Two agents: `victim` holds a real blob; `attacker`'s sandbox wrote links towards it and
    // towards a file outside the tree, under names the store would otherwise act on.
    const victim = blobs.agentRoot("victim");
    const attacker = blobs.agentRoot("attacker");
    await mkdir(join(victim, "secret"), { recursive: true });
    await writeFile(join(victim, "secret", "meta.json"), '{"theirs":true}', "utf8");
    const outside = join(root, "outside.json");
    await writeFile(outside, '{"host":true}', "utf8");
    await mkdir(join(attacker, "real"), { recursive: true });
    await writeFile(join(attacker, "real", "meta.json"), '{"mine":true}', "utf8");
    // A link where a blob directory would be, a link where a sidecar would be, a link to a host file.
    await symlink(join(victim, "secret"), join(attacker, "linked-dir"), "dir");
    await mkdir(join(attacker, "linked-meta"), { recursive: true });
    await symlink(join(victim, "secret", "meta.json"), join(attacker, "linked-meta", "meta.json"));
    await mkdir(join(attacker, "linked-host"), { recursive: true });
    await symlink(outside, join(attacker, "linked-host", "meta.json"));

    // `list` shows the real directories only; a link at the top level is not a directory to it.
    expect(await blobs.list("attacker")).toEqual(["linked-host", "linked-meta", "real"]);
    expect(await blobs.readMeta("attacker", "real")).toBe('{"mine":true}');

    await expect(blobs.readMeta("attacker", "linked-dir")).rejects.toThrow(/symlink/);
    await expect(blobs.readMeta("attacker", "linked-meta")).rejects.toThrow(/symlink/);
    await expect(blobs.readMeta("attacker", "linked-host")).rejects.toThrow(/symlink/);
    await expect(blobs.exists("attacker", "linked-dir")).rejects.toThrow(/symlink/);

    // Refused, not unlinked: `rm` on the link would remove the link alone, which is why the store
    // does not reach for it either way. The link stays and the target is untouched.
    await expect(blobs.remove("attacker", "linked-dir")).rejects.toThrow(/symlink/);
    expect((await lstat(join(attacker, "linked-dir"))).isSymbolicLink()).toBe(true);
    expect(await blobs.readMeta("victim", "secret")).toBe('{"theirs":true}');
    // A directory holding a linked sidecar is a real directory, and removing it is the store's to do.
    await blobs.remove("attacker", "linked-meta");
    expect(await blobs.exists("attacker", "linked-meta")).toBe(false);
    expect(await blobs.readMeta("victim", "secret")).toBe('{"theirs":true}');
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
