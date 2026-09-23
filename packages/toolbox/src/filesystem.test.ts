import { mkdtempSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import { afterAll, describe, expect, it } from "vitest";

import { createFilesystemBlobStore } from "./blob-store";
import { toolboxStoreConformance } from "./conformance";
import { createFilesystemToolboxStore } from "./filesystem";

/**
 * The filesystem backing: the conformance suite, then what is true of a directory alone — where the
 * files land, and that the fake sandbox's toolbox root and this store are one tree.
 */

toolboxStoreConformance("filesystem", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-toolbox-"));
  return {
    store: createFilesystemToolboxStore({ root }),
    close: () => rm(root, { recursive: true, force: true }),
  };
});

describe("the filesystem backing", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-toolbox-fs-"));
  const store = createFilesystemToolboxStore({ root });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it("puts a toolbox under <root>/<toolboxId> and a path under that, as the layout says", async () => {
    await store.writeTree("person-1", "tools/acme/list/v1", [
      { path: "index.ts", content: "x" },
      { path: "lib/h.ts", content: "y" },
    ]);
    expect(store.root).toBe(root);
    expect(store.toolboxRoot("person-1")).toBe(join(root, "person-1"));
    expect(
      await readFile(join(root, "person-1", "tools", "acme", "list", "v1", "index.ts"), "utf8"),
    ).toBe("x");
    expect(
      (await stat(join(root, "person-1", "tools", "acme", "list", "v1", "lib"))).isDirectory(),
    ).toBe(true);
  });

  it("resolves a relative root against the working directory, so GRAFT_TOOLBOX_ROOT's default is absolute", () => {
    const relative = createFilesystemToolboxStore({ root: "./.graft/toolboxes" });
    expect(relative.root).toBe(join(process.cwd(), ".graft", "toolboxes"));
  });

  it("creates no toolbox directory until something is written", async () => {
    expect(await store.exists("person-2", "")).toBe(false);
    expect(await stat(join(root, "person-2")).catch(() => null)).toBeNull();
  });
});

describe("with the fake sandbox backing", () => {
  it("shares one tree: what the store writes, a sandbox that mounted the toolbox reads, and the other way", async () => {
    const sandbox = createFakeSandboxBackend();
    try {
      // The fake keeps toolboxes under `<root>/toolboxes/<id>`; the store is rooted there, which is
      // what the service suite does (`@graft/publish`), and what the Docker backing's bind option
      // does for a real deployment (`filesystem.ts`).
      const store = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
      expect(store.toolboxRoot("person-1")).toBe(sandbox.toolboxRoot("person-1"));

      await store.writeTree("person-1", "tools/acme/list/v1", [
        { path: "index.mjs", content: "export default async () => ({ ok: true });" },
      ]);
      const { handle } = await sandbox.ensure({ name: "s1" });
      await handle.mountToolbox({ toolboxId: "person-1", mountPath: "/tools" });
      expect(await handle.read("/tools/tools/acme/list/v1/index.mjs")).toContain("ok: true");

      await handle.writeTree([{ path: "index.ts", content: "draft" }], "/tools/.drafts/job-1");
      expect(await store.read("person-1", ".drafts/job-1/index.ts")).toBe("draft");

      // The blobs tree is the same root's `.blobs/<agentId>`, and the fake mounts that one directory
      // at `/blobs` (ADR 0023). The fake spells `.blobs` itself, since it cannot import this
      // package; this is where the two spellings are pinned together.
      const blobs = createFilesystemBlobStore({ root: join(sandbox.root, "toolboxes") });
      expect(blobs.agentRoot("agent-1")).toBe(sandbox.blobsRoot("agent-1"));
      await handle.mountToolbox({
        toolboxId: "person-1",
        mountPath: "/tools",
        blobs: { agentId: "agent-1", mountPath: "/blobs" },
      });
      await handle.writeTree([{ path: "meta.json", content: '{"bytes":1}' }], "/blobs/blob-1");
      expect(await blobs.readMeta("agent-1", "blob-1")).toBe('{"bytes":1}');
      expect(await blobs.list("agent-1")).toEqual(["blob-1"]);
      // Beside the toolbox, not in it: nothing of the blob is under `/tools`.
      expect(await handle.ls("/tools")).not.toContain("/tools/.blobs");
    } finally {
      await sandbox.close();
    }
  });
});
