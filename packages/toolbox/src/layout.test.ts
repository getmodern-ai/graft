import { describe, expect, it } from "vitest";

import {
  assertToolboxPath,
  DRAFTS_DIR,
  draftPath,
  isDraftPath,
  PUBLISHED_DIR,
  sandboxPath,
  TOOLBOX_MOUNT_PATH,
  toolboxIdOf,
  toolPath,
  versionPath,
} from "./layout";

describe("the toolbox layout", () => {
  it("names a version tools/<vendor>/<name>/v<N> and a draft .drafts/<jobId>", () => {
    expect(versionPath("unleashed", "list-orders", 3)).toBe("tools/unleashed/list-orders/v3");
    expect(toolPath("unleashed", "list-orders")).toBe("tools/unleashed/list-orders");
    expect(draftPath("job_9")).toBe(".drafts/job_9");
    expect(PUBLISHED_DIR).toBe("tools");
    expect(DRAFTS_DIR).toBe(".drafts");
  });

  it("refuses a version number that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => versionPath("a", "b", bad)).toThrow(/positive integer/);
    }
  });

  it("refuses a segment that could be a path", () => {
    for (const bad of ["", "..", ".", "a/b", "a b", "/a", "-a"]) {
      expect(() => toolPath(bad, "ok")).toThrow(/vendor slug/);
      expect(() => toolPath("ok", bad)).toThrow(/tool name/);
      expect(() => draftPath(bad)).toThrow(/job id/);
    }
  });

  it("tells a draft path from everything else", () => {
    expect(isDraftPath(".drafts/job-1")).toBe(true);
    expect(isDraftPath(".drafts/job-1/index.ts")).toBe(true);
    expect(isDraftPath(".drafts")).toBe(false);
    expect(isDraftPath(".drafts/")).toBe(false);
    expect(isDraftPath("tools/a/b/v1")).toBe(false);
    expect(isDraftPath("")).toBe(false);
  });

  it("prepends the mount path for a process inside a sandbox", () => {
    expect(TOOLBOX_MOUNT_PATH).toBe("/tools");
    expect(sandboxPath("tools/unleashed/list-orders/v3")).toBe(
      "/tools/tools/unleashed/list-orders/v3",
    );
    expect(sandboxPath("")).toBe("/tools");
    expect(() => sandboxPath("/abs")).toThrow(/toolbox path/);
  });

  it("uses the person's id as the toolbox id, and refuses one a volume could not be named after", () => {
    expect(toolboxIdOf("Ab12_cd.ef-99")).toBe("Ab12_cd.ef-99");
    expect(() => toolboxIdOf("has/slash")).toThrow(/toolbox id/);
    expect(() => toolboxIdOf("")).toThrow(/toolbox id/);
  });

  it("validates a toolbox path: relative, forward slashes, no dot segments, root only where allowed", () => {
    expect(() => assertToolboxPath("tools/a/b/v1")).not.toThrow();
    expect(() => assertToolboxPath("", { allowRoot: true })).not.toThrow();
    expect(() => assertToolboxPath("")).toThrow(/not the toolbox itself/);
    for (const bad of ["/x", "a//b", "./a", "a/../b", "a\\b", "a\0b", "..", "."]) {
      expect(() => assertToolboxPath(bad), bad).toThrow(/toolbox path/);
    }
  });
});
