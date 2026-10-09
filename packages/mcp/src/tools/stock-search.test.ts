import { STARTER_VENDORS } from "@graft/core";
import { readStockWorkspace, type StockWorkspaceTool } from "@graft/stock";
import { beforeAll, describe, expect, it } from "vitest";

import { type IndexedTool, searchTools } from "./tool-index";

/**
 * The stock catalogue as shipped, searched by the words a person would use (ADR 0025; GRA-250, GRA-259):
 * each case is the query a person asks for one stock tool, and that tool must be the first hit
 * over the whole workspace, every vendor's tools together, with the integration's display name
 * as `find_tool` boosts it (`meta.ts`'s `VENDOR_NAMES`). A new stock tool adds its query here.
 */
const VENDOR_NAMES = new Map(STARTER_VENDORS.map((s) => [s.vendor, [s.displayName]]));

const CASES: [query: string, tool: string][] = [
  ["current weather", "open-meteo__current-weather"],
  ["find a spreadsheet", "google-sheets__find-spreadsheets"],
  ["list my spreadsheets", "google-sheets__find-spreadsheets"],
  ["what tabs are in this spreadsheet", "google-sheets__list-tabs"],
  ["read my spreadsheet", "google-sheets__read-rows"],
  ["read the rows of a sheet", "google-sheets__read-rows"],
  ["find rows", "google-sheets__find-rows"],
  ["find rows where a column matches a value", "google-sheets__find-rows"],
  ["add a row to the sheet", "google-sheets__append-rows"],
  ["append rows to a spreadsheet", "google-sheets__append-rows"],
  ["update cells in a sheet", "google-sheets__update-range"],
  ["create a spreadsheet", "google-sheets__create-spreadsheet"],
  ["add a tab to a spreadsheet", "google-sheets__add-tab"],
];

let catalogue: (IndexedTool & { wire: string })[] = [];

beforeAll(async () => {
  const tools: StockWorkspaceTool[] = await readStockWorkspace();
  catalogue = tools.map((tool) => ({
    vendor: tool.vendor,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations.readOnly,
    wire: `${tool.vendor}__${tool.name}`,
  }));
});

describe("the stock catalogue answers a person's words (GRA-250, GRA-259)", () => {
  it.each(CASES)('"%s" finds %s first', (query, wire) => {
    const found = searchTools(catalogue, query, { vendorNames: VENDOR_NAMES });
    expect(found.hits[0]?.wire).toBe(wire);
  });

  it("covers every stock tool with a query", () => {
    const covered = new Set(CASES.map(([, wire]) => wire));
    expect(catalogue.map((tool) => tool.wire).filter((wire) => !covered.has(wire))).toEqual([]);
  });
});
