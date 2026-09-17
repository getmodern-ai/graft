import type { AuthoredToolRow, ToolVersionRow } from "@graft/db/repo/tool";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { ToolDeps } from "./tool.deps";
import {
  activateToolVersion,
  addToolVersion,
  createTool,
  nextVersionNumber,
  publishToolVersion,
  recordDryRun,
  updateToolDefinition,
  validateToolDefinition,
} from "./tool.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };

const tool: AuthoredToolRow = {
  id: "tool_1",
  personId: "person_1",
  vendor: "unleashed",
  name: "list-orders",
  description: "Lists orders",
  inputSchema: { type: "object", properties: {} },
  currentVersionId: null,
  readOnly: true,
  destructive: false,
  defaultConnectionId: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const version = (n: number): ToolVersionRow => ({
  id: `ver_${n}`,
  toolId: "tool_1",
  versionNumber: n,
  path: `unleashed/list-orders/v${n}`,
  sourceHash: "abc",
  lockfileHash: null,
  checkOutput: {},
  dryRunOutcome: null,
  dryRunAt: null,
  writesInvolved: false,
  publisherJobId: null,
  owner: "person",
  createdAt: NOW,
});

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    insertAuthoredTool: vi.fn(async (_db, input) => ({ ...tool, ...input }) as AuthoredToolRow),
    findAuthoredTool: vi.fn(async () => null),
    findAuthoredToolById: vi.fn(async () => tool),
    listAuthoredTools: vi.fn(async () => [tool]),
    updateAuthoredTool: vi.fn(async (_db, _p, _id, patch) => ({ ...tool, ...patch })),
    insertToolVersion: vi.fn(async (_db, input) => ({ ...version(1), ...input }) as ToolVersionRow),
    listToolVersions: vi.fn(async () => [version(2), version(1)]),
    findToolVersion: vi.fn(async () => version(1)),
    setCurrentToolVersion: vi.fn(async (_db, _p, _t, versionId) => ({
      ...tool,
      currentVersionId: versionId,
    })),
    recordToolVersionDryRun: vi.fn(async () => version(1)),
    findConnection: vi.fn(async () => ({ id: "conn_1" }) as never),
    newId: () => "new_id",
    now: () => NOW,
    ...overrides,
  };
}

const input = {
  vendor: "unleashed",
  name: "list-orders",
  description: "Lists orders",
  inputSchema: { type: "object" },
  annotations: { readOnly: true, destructive: false },
};

describe("createTool", () => {
  it("writes the person's tool with the check's annotations and no version yet", async () => {
    const deps = fakeDeps();
    await createTool(ctx, PRINCIPAL, input, deps);
    expect(deps.insertAuthoredTool).toHaveBeenCalledWith(fakeDb, {
      id: "new_id",
      personId: "person_1",
      vendor: "unleashed",
      name: "list-orders",
      description: "Lists orders",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: null,
    });
  });

  it("refuses a name that is not kebab-case, a non-object schema and a bad vendor", async () => {
    const deps = fakeDeps();
    for (const bad of [
      { ...input, name: "listOrders" },
      { ...input, inputSchema: { type: "string" } },
      { ...input, vendor: "Unleashed" },
      { ...input, description: "" },
    ]) {
      await expect(createTool(ctx, PRINCIPAL, bad, deps)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(deps.insertAuthoredTool).not.toHaveBeenCalled();
  });

  it("refuses a second tool of the same vendor and name as CONFLICT, naming the existing id", async () => {
    const deps = fakeDeps({ findAuthoredTool: vi.fn(async () => tool) });
    await expect(createTool(ctx, PRINCIPAL, input, deps)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { toolId: "tool_1" },
    });
  });

  it("refuses a default connection that is not the person's as NOT_FOUND", async () => {
    const deps = fakeDeps({ findConnection: vi.fn(async () => null) });
    await expect(
      createTool(ctx, PRINCIPAL, { ...input, defaultConnectionId: "conn_x" }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("addToolVersion", () => {
  it("numbers the new version after the latest", async () => {
    const deps = fakeDeps();
    await addToolVersion(
      ctx,
      PRINCIPAL,
      "tool_1",
      { path: "p/v3", sourceHash: "h", checkOutput: {} },
      deps,
    );
    expect(deps.insertToolVersion).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: "new_id", toolId: "tool_1", versionNumber: 3, path: "p/v3" }),
    );
  });

  it("starts at one for a tool with no versions", async () => {
    const deps = fakeDeps({ listToolVersions: vi.fn(async () => []) });
    await addToolVersion(
      ctx,
      PRINCIPAL,
      "tool_1",
      { path: "p/v1", sourceHash: "h", checkOutput: {} },
      deps,
    );
    expect(vi.mocked(deps.insertToolVersion).mock.calls[0]?.[1]).toMatchObject({
      versionNumber: 1,
    });
  });

  it("refuses a tool that is not the person's", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(
      addToolVersion(
        ctx,
        PRINCIPAL,
        "tool_x",
        { path: "p", sourceHash: "h", checkOutput: {} },
        deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.insertToolVersion).not.toHaveBeenCalled();
  });
});

describe("nextVersionNumber", () => {
  it("is one past the latest, one for a tool with none, and null for a tool that is not the person's", async () => {
    expect(await nextVersionNumber(ctx, PRINCIPAL, "tool_1", fakeDeps())).toBe(3);
    expect(
      await nextVersionNumber(
        ctx,
        PRINCIPAL,
        "tool_1",
        fakeDeps({ listToolVersions: vi.fn(async () => []) }),
      ),
    ).toBe(1);
    expect(
      await nextVersionNumber(
        ctx,
        PRINCIPAL,
        "tool_x",
        fakeDeps({ findAuthoredToolById: vi.fn(async () => null) }),
      ),
    ).toBeNull();
  });
});

describe("validateToolDefinition", () => {
  it("passes a good definition and refuses each bad field as BAD_REQUEST, touching nothing", () => {
    expect(() => validateToolDefinition(input)).not.toThrow();
    for (const bad of [
      { ...input, name: "listOrders" },
      { ...input, vendor: "Unleashed" },
      { ...input, description: "   " },
      { ...input, inputSchema: { type: "array" } },
    ]) {
      expect(() => validateToolDefinition(bad)).toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    }
  });
});

describe("publishToolVersion", () => {
  it("adds the version, updates the definition and moves the pointer, in order, in one transaction", async () => {
    const deps = fakeDeps();
    const result = await publishToolVersion(
      ctx,
      PRINCIPAL,
      "tool_1",
      { path: "p/v3", sourceHash: "h", checkOutput: { refusals: [] }, writesInvolved: true },
      { description: "Lists orders, paged", annotations: { readOnly: false, destructive: false } },
      deps,
    );

    expect(vi.mocked(deps.insertToolVersion).mock.calls[0]?.[1]).toMatchObject({
      versionNumber: 3,
      writesInvolved: true,
    });
    expect(deps.updateAuthoredTool).toHaveBeenCalledWith(fakeDb, "person_1", "tool_1", {
      description: "Lists orders, paged",
      readOnly: false,
      destructive: false,
    });
    expect(deps.setCurrentToolVersion).toHaveBeenCalledWith(fakeDb, "person_1", "tool_1", "new_id");
    expect(result.tool.currentVersionId).toBe("new_id");
    expect(result.version.id).toBe("new_id");
  });
});

describe("activateToolVersion", () => {
  it("applies the definition and moves the pointer onto the version, in one transaction, without inserting anything", async () => {
    const deps = fakeDeps();
    const result = await activateToolVersion(
      ctx,
      PRINCIPAL,
      "tool_1",
      "ver_2",
      {
        description: "Lists orders, paged",
        inputSchema: { type: "object", properties: { page: { type: "integer" } } },
        annotations: { readOnly: true, destructive: false },
        defaultConnectionId: "conn_1",
      },
      deps,
    );

    expect(deps.insertToolVersion).not.toHaveBeenCalled();
    expect(deps.updateAuthoredTool).toHaveBeenCalledWith(fakeDb, "person_1", "tool_1", {
      description: "Lists orders, paged",
      inputSchema: { type: "object", properties: { page: { type: "integer" } } },
      readOnly: true,
      destructive: false,
      defaultConnectionId: "conn_1",
    });
    expect(deps.setCurrentToolVersion).toHaveBeenCalledWith(fakeDb, "person_1", "tool_1", "ver_2");
    expect(result.currentVersionId).toBe("ver_2");
  });

  it("is NOT_FOUND when the version is not the tool's — the pointer move lands nowhere", async () => {
    const deps = fakeDeps({ setCurrentToolVersion: vi.fn(async () => null) });
    await expect(
      activateToolVersion(ctx, PRINCIPAL, "tool_1", "ver_of_another_tool", {}, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses as CONFLICT a version below the current one, naming both numbers, and writes nothing", async () => {
    const byId: Record<string, ToolVersionRow> = { ver_1: version(1), ver_2: version(2) };
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(async () => ({ ...tool, currentVersionId: "ver_2" })),
      findToolVersion: vi.fn(async (_db, _p, id) => byId[id] ?? null),
    });
    await expect(
      activateToolVersion(ctx, PRINCIPAL, "tool_1", "ver_1", { description: "Older" }, deps),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "v2 of unleashed/list-orders is already current, so v1 cannot become current: the pointer only moves forward",
      details: { currentVersionId: "ver_2", currentVersionNumber: 2, versionNumber: 1 },
    });
    expect(deps.updateAuthoredTool).not.toHaveBeenCalled();
    expect(deps.setCurrentToolVersion).not.toHaveBeenCalled();

    // The same version again, and a later one, both pass.
    for (const id of ["ver_2", "ver_3"]) {
      byId.ver_3 = version(3);
      const result = await activateToolVersion(ctx, PRINCIPAL, "tool_1", id, {}, deps);
      expect(result.currentVersionId).toBe(id);
    }
  });
});

describe("updateToolDefinition", () => {
  it("passes only the given keys, flattening the annotations", async () => {
    const deps = fakeDeps();
    await updateToolDefinition(
      ctx,
      PRINCIPAL,
      "tool_1",
      { annotations: { readOnly: false, destructive: true } },
      deps,
    );
    expect(deps.updateAuthoredTool).toHaveBeenCalledWith(fakeDb, "person_1", "tool_1", {
      readOnly: false,
      destructive: true,
    });
  });
});

describe("recordDryRun", () => {
  it("stamps the clock when no time is given", async () => {
    const deps = fakeDeps();
    await recordDryRun(
      ctx,
      PRINCIPAL,
      "ver_1",
      { report: { passed: true }, writesInvolved: false },
      deps,
    );
    expect(deps.recordToolVersionDryRun).toHaveBeenCalledWith(fakeDb, "person_1", "ver_1", {
      report: { passed: true },
      writesInvolved: false,
      at: NOW,
    });
  });
});
