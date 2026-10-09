import type { StockToolView } from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox/fake";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceStockCopy, copyStockVersion } from "./copy-stock";
import { createFakeMetadataSource } from "./metadata";
import { DEFAULT_PACKAGE_POLICY } from "./policy";
import type { PublishDeps } from "./publish.service";
import { createInMemoryToolDeps, fakeDb, type InMemoryToolDeps } from "./testing";

/**
 * The copy of a stock version into a person's toolbox (ADR 0025; GRA-238): the version directory
 * written from the catalogue's files, an ordinary tool and version recording the stock origin, the
 * pointer on it. What is asserted is the toolbox and the rows a run then reads.
 */

const PERSON = "person1";

const STOCK: StockToolView = {
  stockToolId: "stock_weather",
  stockVersionId: "stock_weather_v3",
  versionNumber: 3,
  vendor: "open-meteo",
  name: "current-weather",
  description: "The weather right now in a named city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  annotations: { readOnly: true, destructive: false },
  hosts: ["api.open-meteo.com"],
  files: [{ path: "index.ts", content: "export default async () => ({ ok: true });\n" }],
  checkOutput: { refusals: [], advice: [], annotations: { readOnly: true, destructive: false } },
  connect: null,
};

let sandbox: FakeSandboxBackend;
let tool: InMemoryToolDeps;
let deps: PublishDeps;

beforeEach(() => {
  sandbox = createFakeSandboxBackend();
  tool = createInMemoryToolDeps();
  deps = {
    db: fakeDb,
    store: createFilesystemToolboxStore({ root: `${sandbox.root}/toolboxes` }),
    mirror: createNoopToolboxMirror(),
    sandbox,
    metadata: createFakeMetadataSource({}),
    policy: DEFAULT_PACKAGE_POLICY,
    tool,
    check: async () => {
      throw new Error("a copy runs no check: the catalogue's version carries its result");
    },
    now: () => new Date(),
    onMirror: () => {},
  };
});

afterEach(async () => {
  await sandbox.close();
});

describe("copyStockVersion", () => {
  it("writes the stock version as version 1 of an ordinary tool, recording its stock origin", async () => {
    const copied = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    expect(copied).toMatchObject({
      personId: PERSON,
      vendor: "open-meteo",
      name: "current-weather",
      description: STOCK.description,
      inputSchema: STOCK.inputSchema,
      readOnly: true,
      destructive: false,
    });
    const [version] = tool.versions;
    expect(copied.currentVersionId).toBe(version?.id);
    expect(version).toMatchObject({
      versionNumber: 1,
      path: "tools/open-meteo/current-weather/v1",
      stockToolId: "stock_weather",
      stockVersionId: "stock_weather_v3",
      writesInvolved: false,
    });
    const files = await deps.store.readTree(PERSON, "tools/open-meteo/current-weather/v1");
    expect(files.map((file) => file.path).sort()).toEqual(["index.ts"]);
  });

  it("answers the person's tool and writes nothing when they already hold one of that name", async () => {
    const first = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    const second = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    expect(second.id).toBe(first.id);
    expect(tool.versions).toHaveLength(1);
  });
});

describe("advanceStockCopy", () => {
  const V4: StockToolView = {
    ...STOCK,
    stockVersionId: "stock_weather_v4",
    versionNumber: 4,
    description: "The weather right now in a named city, with the wind.",
    files: [{ path: "index.ts", content: "export default async () => ({ ok: 4 });\n" }],
  };
  const copy = () =>
    copyStockVersion(deps, { personId: PERSON, stock: STOCK, defaultConnectionId: null });

  it("writes the catalogue's newer version as the copy's next version and moves the pointer", async () => {
    const copied = await copy();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    expect(advance).toMatchObject({
      advanced: true,
      stockVersionNumber: 4,
      previous: { readOnly: true, destructive: false },
      version: {
        versionNumber: 2,
        path: "tools/open-meteo/current-weather/v2",
        stockToolId: "stock_weather",
        stockVersionId: "stock_weather_v4",
      },
    });
    expect(advance.tool.currentVersionId).toBe(advance.advanced ? advance.version.id : null);
    expect(advance.tool.description).toBe(V4.description);
    const files = await deps.store.readTree(PERSON, "tools/open-meteo/current-weather/v2");
    expect(files.find((file) => file.path === "index.ts")?.content).toContain("ok: 4");
  });

  it("stays on a copy already at the catalogue's current version", async () => {
    const copied = await copy();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: STOCK,
    });
    expect(advance.advanced).toBe(false);
    expect(tool.versions).toHaveLength(1);
  });

  it("never advances a remix: a version the agent published stops the copy following", async () => {
    const copied = await copy();
    const [first] = tool.versions;
    if (!first) throw new Error("the copy wrote no version");
    tool.versions.push({
      ...first,
      id: "remix_v2",
      versionNumber: 2,
      stockToolId: null,
      stockVersionId: null,
    });
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    expect(advance.advanced).toBe(false);
    expect(tool.versions).toHaveLength(2);
  });

  it("answers the tool untouched when a racing publish took the version number first", async () => {
    const copied = await copy();
    const insert = tool.insertToolVersion;
    tool.insertToolVersion = async () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    };
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    tool.insertToolVersion = insert;
    expect(advance).toMatchObject({ advanced: false, tool: { id: copied.id } });
  });
});

/**
 * ADR 0008 as amended 2026-10-09 (GRA-245): a new stock version keeps the approval unless its
 * annotations widen. What is asserted is the version each agent's answer stands for afterwards.
 */
describe("advanceStockCopy and the approvals given for the copy", () => {
  const WRITE: StockToolView = {
    ...STOCK,
    name: "save-place",
    annotations: { readOnly: false, destructive: false },
    checkOutput: { refusals: [], advice: [], annotations: { readOnly: false, destructive: false } },
  };
  const next = (annotations: StockToolView["annotations"]): StockToolView => ({
    ...WRITE,
    stockVersionId: "stock_place_v4",
    versionNumber: 4,
    annotations,
    checkOutput: { ...WRITE.checkOutput, annotations },
  });
  const approved = async () => {
    const copied = await copyStockVersion(deps, {
      personId: PERSON,
      stock: WRITE,
      defaultConnectionId: null,
    });
    tool.approvals.push(
      { agentId: "agent_a", toolId: copied.id, toolVersionId: copied.currentVersionId },
      // An answer already given for an older version stays stale: the carry is not a grant.
      { agentId: "agent_b", toolId: copied.id, toolVersionId: "older_version" },
    );
    // The fake's tool row is the object the advance moves, so its version is read now.
    return { copied, before: copied.currentVersionId };
  };

  it("carries the answers given for the version before onto the new one when the annotations hold", async () => {
    const { copied } = await approved();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: next({ readOnly: false, destructive: false }),
    });
    if (!advance.advanced) throw new Error("the copy did not advance");
    expect(tool.approvals).toEqual([
      { agentId: "agent_a", toolId: copied.id, toolVersionId: advance.version.id },
      { agentId: "agent_b", toolId: copied.id, toolVersionId: "older_version" },
    ]);
  });

  it("leaves every answer on the version before when the new version turns destructive", async () => {
    const { copied, before } = await approved();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: next({ readOnly: false, destructive: true }),
    });
    expect(advance.advanced).toBe(true);
    expect(tool.approvals.map((row) => row.toolVersionId)).toEqual([before, "older_version"]);
  });
});
