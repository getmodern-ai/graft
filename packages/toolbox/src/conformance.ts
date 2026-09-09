import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolboxStore } from "./types";

/**
 * One suite, every backing of the store (ADR 0002). The filesystem backing runs it here; a second
 * backing runs it from its own test file with a way to construct itself, and a change to the seam
 * lands here first. What is asserted is what a caller observes through the seam — files back,
 * names back, a rejection — never how the backing kept them.
 */

export type ToolboxStoreFixture = {
  store: ToolboxStore;
  close?: () => Promise<void>;
};

export function toolboxStoreConformance(
  name: string,
  makeFixture: () => Promise<ToolboxStoreFixture>,
): void {
  describe(`toolbox store conformance: ${name}`, () => {
    let fixture: ToolboxStoreFixture;
    let store: ToolboxStore;
    const toolbox = `conf-${Date.now().toString(36)}`;

    beforeAll(async () => {
      fixture = await makeFixture();
      store = fixture.store;
    });

    afterAll(async () => {
      await fixture.close?.();
    });

    it("writes a tree and reads it back sorted, with paths relative to the directory asked about", async () => {
      await store.writeTree(toolbox, "tools/acme/list/v1", [
        { path: "index.ts", content: "export default async () => 1;\n" },
        { path: "lib/helper.ts", content: "export const x = 1;\n" },
        { path: "package.json", content: "{}\n" },
      ]);

      expect(await store.readTree(toolbox, "tools/acme/list/v1")).toEqual([
        { path: "index.ts", content: "export default async () => 1;\n" },
        { path: "lib/helper.ts", content: "export const x = 1;\n" },
        { path: "package.json", content: "{}\n" },
      ]);
      expect(await store.readTree(toolbox, "tools/acme/list/v1/lib")).toEqual([
        { path: "helper.ts", content: "export const x = 1;\n" },
      ]);
      expect(await store.read(toolbox, "tools/acme/list/v1/package.json")).toBe("{}\n");
    });

    it("overwrites a file of the same name and leaves the others", async () => {
      await store.writeTree(toolbox, "tools/acme/list/v1", [
        { path: "index.ts", content: "export default async () => 2;\n" },
      ]);
      const tree = await store.readTree(toolbox, "tools/acme/list/v1");
      expect(tree.map((file) => file.path)).toEqual(["index.ts", "lib/helper.ts", "package.json"]);
      expect(tree[0]?.content).toBe("export default async () => 2;\n");
    });

    it("lists the names directly under a directory, and the root", async () => {
      await store.writeTree(toolbox, "tools/acme/list/v2", [{ path: "index.ts", content: "" }]);
      expect(await store.list(toolbox, "tools/acme/list")).toEqual(["v1", "v2"]);
      expect(await store.list(toolbox, "tools/acme/list/v1")).toEqual([
        "index.ts",
        "lib",
        "package.json",
      ]);
      expect(await store.list(toolbox, "")).toEqual(["tools"]);
    });

    it("answers exists for a directory, a file and nothing", async () => {
      expect(await store.exists(toolbox, "tools/acme/list/v1")).toBe(true);
      expect(await store.exists(toolbox, "tools/acme/list/v1/index.ts")).toBe(true);
      expect(await store.exists(toolbox, "tools/acme/list/v9")).toBe(false);
      expect(await store.exists("never-written", "")).toBe(false);
    });

    it("rejects a read, a tree read and a list of what is not there, so a caller asks exists first", async () => {
      await expect(store.read(toolbox, "tools/acme/list/v1/missing.ts")).rejects.toThrow(/no such/);
      await expect(store.read(toolbox, "tools/acme/list/v1")).rejects.toThrow(/no such file/);
      await expect(store.readTree(toolbox, "tools/acme/none")).rejects.toThrow(/no such/);
      await expect(store.readTree(toolbox, "tools/acme/list/v1/index.ts")).rejects.toThrow(
        /no such directory/,
      );
      await expect(store.list(toolbox, "tools/acme/none")).rejects.toThrow(/no such/);
    });

    it("keeps two toolboxes apart", async () => {
      await store.writeTree("other-toolbox", "tools/acme/list/v1", [
        { path: "index.ts", content: "other" },
      ]);
      expect(await store.read("other-toolbox", "tools/acme/list/v1/index.ts")).toBe("other");
      expect(await store.read(toolbox, "tools/acme/list/v1/index.ts")).not.toBe("other");
      expect(await store.exists("other-toolbox", "tools/acme/list/v2")).toBe(false);
    });

    it("removes a draft, and a draft that is already gone is not an error", async () => {
      await store.writeTree(toolbox, ".drafts/job-1", [
        { path: "index.ts", content: "draft" },
        { path: "deep/er/file.txt", content: "x" },
      ]);
      expect(await store.exists(toolbox, ".drafts/job-1")).toBe(true);

      await store.remove(toolbox, ".drafts/job-1");
      expect(await store.exists(toolbox, ".drafts/job-1")).toBe(false);
      await expect(store.remove(toolbox, ".drafts/job-1")).resolves.toBeUndefined();
    });

    it("removes a file or directory inside a draft, too", async () => {
      await store.writeTree(toolbox, ".drafts/job-2", [
        { path: "index.ts", content: "draft" },
        { path: "scratch/notes.txt", content: "x" },
      ]);
      await store.remove(toolbox, ".drafts/job-2/scratch");
      expect(await store.list(toolbox, ".drafts/job-2")).toEqual(["index.ts"]);
    });

    it("refuses to remove anything that is not a draft — a version, a tool, the drafts directory, the root", async () => {
      for (const path of ["tools/acme/list/v1", "tools/acme/list", "tools", ".drafts", ""]) {
        await expect(store.remove(toolbox, path)).rejects.toThrow(/only a draft|not the toolbox/);
      }
      expect(await store.exists(toolbox, "tools/acme/list/v1/index.ts")).toBe(true);
    });

    it("refuses a path that leaves the toolbox, on every verb, before touching anything", async () => {
      for (const bad of ["../x", "tools/../../x", "/etc/passwd", "tools//x", "tools/./x", "a\\b"]) {
        await expect(store.exists(toolbox, bad)).rejects.toThrow(/toolbox path/);
        await expect(store.readTree(toolbox, bad)).rejects.toThrow(/toolbox path/);
        await expect(store.read(toolbox, bad)).rejects.toThrow(/toolbox path/);
        await expect(store.list(toolbox, bad)).rejects.toThrow(/toolbox path/);
        await expect(store.writeTree(toolbox, bad, [])).rejects.toThrow(/toolbox path/);
        await expect(store.remove(toolbox, bad)).rejects.toThrow(/toolbox path/);
      }
      await expect(
        store.writeTree(toolbox, "tools/acme/list/v1", [{ path: "../escape.ts", content: "" }]),
      ).rejects.toThrow(/toolbox path/);
      await expect(store.writeTree(toolbox, "", [{ path: "x", content: "" }])).rejects.toThrow(
        /not the toolbox itself/,
      );
    });

    it("refuses a toolbox id that is not a legal directory or volume name", async () => {
      for (const bad of ["", "../other", "a/b", ".hidden", "with space"]) {
        await expect(store.exists(bad, "tools")).rejects.toThrow(/toolbox id/);
        await expect(store.writeTree(bad, "tools/x/y/v1", [])).rejects.toThrow(/toolbox id/);
      }
    });
  });
}
