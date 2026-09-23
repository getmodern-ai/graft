import { describe, expect, it } from "vitest";

import {
  agentBlobsPath,
  assertAgentId,
  assertBlobId,
  assertToolboxPath,
  BLOB_DATA_FILE,
  BLOB_META_FILE,
  BLOB_TMP_SUFFIX,
  BLOBS_MOUNT_PATH,
  BLOBS_ROOT,
  blobPath,
  blobSandboxPath,
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

  it("names the blobs tree beside the toolboxes: .blobs/<agentId>/<blobId> relative to the root, /blobs/<blobId> in the sandbox", () => {
    expect(BLOBS_ROOT).toBe(".blobs");
    expect(BLOBS_MOUNT_PATH).toBe("/blobs");
    expect(agentBlobsPath("agent-1")).toBe(".blobs/agent-1");
    expect(blobPath("agent-1", "6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d")).toBe(
      ".blobs/agent-1/6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d",
    );
    expect(blobSandboxPath("6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d")).toBe(
      "/blobs/6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d",
    );
    // The sandbox form carries no agent id: the mount is already the agent's (ADR 0023).
    expect(blobSandboxPath("blob-1")).not.toContain("agent");
  });

  it("spells the two files of a blob and the suffix of one still being written once", () => {
    expect(BLOB_DATA_FILE).toBe("data");
    expect(BLOB_META_FILE).toBe("meta.json");
    expect(BLOB_TMP_SUFFIX).toBe(".tmp");
    expect(`${blobPath("agent-1", "blob-1")}${BLOB_TMP_SUFFIX}`).toBe(".blobs/agent-1/blob-1.tmp");
  });

  it("refuses an agent id or a blob id that could be a path, wherever one is taken", () => {
    for (const bad of ["", "..", ".", "a/b", "a b", "/a", "-a", ".hidden"]) {
      expect(() => assertAgentId(bad), bad).toThrow(/agent id/);
      expect(() => assertBlobId(bad), bad).toThrow(/blob id/);
      expect(() => agentBlobsPath(bad), bad).toThrow(/agent id/);
      expect(() => blobPath(bad, "ok"), bad).toThrow(/agent id/);
      expect(() => blobPath("ok", bad), bad).toThrow(/blob id/);
      expect(() => blobSandboxPath(bad), bad).toThrow(/blob id/);
    }
    // A UUID, which is what every id here is minted as, passes.
    expect(() => assertAgentId("6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d")).not.toThrow();
    expect(() => assertBlobId("6f1c2b0e-0f4d-4a3b-9c1e-2d5f7a8b9c0d")).not.toThrow();
  });

  it("keeps the blobs tree out of every toolbox: no toolbox can be named .blobs and no draft path is a blob path", () => {
    expect(() => toolboxIdOf(BLOBS_ROOT)).toThrow(/toolbox id/);
    expect(isDraftPath(blobPath("agent-1", "blob-1"))).toBe(false);
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
