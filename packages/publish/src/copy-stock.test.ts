import type { StockToolView } from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox/fake";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyStockVersion } from "./copy-stock";
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
