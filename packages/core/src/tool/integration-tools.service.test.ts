import type { DbOrTx } from "@graft/db";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { ToolLastRunRow } from "@graft/db/repo/usage";
import { describe, expect, it, vi } from "vitest";

import { loadStockCatalogue, type StockToolSource } from "../stock/stock.service";
import { createFakeStockCatalogue } from "../stock/testing/fake-stock-deps";
import type { IntegrationToolsDeps } from "./integration-tools.deps";
import { listIntegrationTools } from "./integration-tools.service";

/**
 * An integration's tools read (GRA-293) over fakes: the person's tools of the vendor with a current
 * version, the stock tools they hold none of, and each tool's last run.
 */

const NOW = new Date("2026-10-14T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb as unknown as DbOrTx };

const row = (name: string, overrides: Partial<AuthoredToolRow> = {}): AuthoredToolRow => ({
  id: `tool_${name}`,
  personId: "person_1",
  vendor: "gmail",
  name,
  description: `${name} described`,
  inputSchema: { type: "object", properties: {} },
  currentVersionId: `ver_${name}`,
  readOnly: true,
  destructive: false,
  defaultConnectionId: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const stockSource = (name: string): StockToolSource => ({
  vendor: "gmail",
  name,
  description: `stock ${name}`,
  inputSchema: { type: "object", properties: {} },
  hosts: ["gmail.googleapis.com"],
  files: [{ path: "index.ts", content: "export default async () => ({});\n" }],
  testInput: {},
  sourceHash: `hash-${name}`,
});

async function depsWith(args: {
  tools: AuthoredToolRow[];
  stock: string[];
  runs?: ToolLastRunRow[];
}): Promise<IntegrationToolsDeps> {
  const catalogue = createFakeStockCatalogue();
  await loadStockCatalogue(
    ctx,
    args.stock.map(stockSource),
    async () => ({
      ok: true,
      annotations: { readOnly: true, destructive: false },
      checkOutput: {},
    }),
    catalogue.deps,
  );
  return {
    listAuthoredToolsForVendor: vi.fn(async () => args.tools),
    listCurrentStockToolsForVendor: catalogue.deps.listCurrentStockToolsForVendor,
    lastRunByToolForPerson: vi.fn(async () => args.runs ?? []),
  };
}

describe("listIntegrationTools", () => {
  it("hides a stock tool the person holds a tool of the name of, versionless included, and never lists a versionless tool", async () => {
    const deps = await depsWith({
      tools: [row("find-invoices"), row("draft-reply", { currentVersionId: null })],
      stock: ["find-invoices", "draft-reply", "send-email"],
    });
    const tools = await listIntegrationTools(ctx, PRINCIPAL, "gmail", deps);
    expect(tools.map((tool) => [tool.source, tool.name, tool.toolId])).toEqual([
      ["toolbox", "find-invoices", "tool_find-invoices"],
      ["stock", "send-email", null],
    ]);
    expect(tools[0]?.description).toBe("find-invoices described");
    expect(tools[1]).toMatchObject({ tool: "gmail__send-email", lastRun: null });
    expect(deps.listAuthoredToolsForVendor).toHaveBeenCalledWith(ctx.db, "person_1", "gmail");
    expect(deps.lastRunByToolForPerson).toHaveBeenCalledWith(ctx.db, "person_1", {
      vendor: "gmail",
    });
  });

  it("carries each tool's last run with its agent, and lists the most recently run first", async () => {
    const deps = await depsWith({
      tools: [row("a-tool"), row("b-tool"), row("c-tool")],
      stock: ["d-stock"],
      runs: [
        {
          toolId: "tool_c-tool",
          lastRunAt: new Date("2026-10-14T09:58:00Z"),
          outcome: "ok",
          agentId: "agent_1",
          agentName: "Codex",
        },
        {
          toolId: "tool_b-tool",
          lastRunAt: new Date("2026-10-14T09:00:00Z"),
          outcome: "error",
          agentId: "agent_2",
          agentName: "Claude",
        },
      ],
    });
    const tools = await listIntegrationTools(ctx, PRINCIPAL, "gmail", deps);
    expect(tools.map((tool) => tool.name)).toEqual(["c-tool", "b-tool", "a-tool", "d-stock"]);
    expect(tools[0]?.lastRun).toEqual({
      at: new Date("2026-10-14T09:58:00Z"),
      outcome: "ok",
      agent: { id: "agent_1", name: "Codex" },
    });
    expect(tools[2]?.lastRun).toBeNull();
  });
});
