import { STARTER_VENDORS } from "@graft/core";
import { readStockWorkspace, type StockWorkspaceTool } from "@graft/stock";
import { beforeAll, describe, expect, it } from "vitest";

import { type IndexedTool, searchTools } from "./tool-index";

/**
 * The stock catalogue as shipped, searched by the words a person would use (ADR 0025; GRA-250):
 * each case is the query a person asks for one stock tool, and that tool must be the first hit
 * over the whole workspace, every vendor's tools together, with the integration's display name
 * as `find_tool` boosts it (`meta.ts`'s `VENDOR_NAMES`). A new stock tool adds its query here.
 */
const VENDOR_NAMES = new Map(STARTER_VENDORS.map((s) => [s.vendor, [s.displayName]]));

const CASES: [query: string, tool: string][] = [
  ["current weather", "open-meteo__current-weather"],
  ["search my google drive files", "google-drive__search-files"],
  ["search drive for a file", "google-drive__search-files"],
  ["recent drive files", "google-drive__list-recent-files"],
  ["list my recently modified files", "google-drive__list-recent-files"],
  ["list files in a drive folder", "google-drive__list-folder"],
  ["drive file details", "google-drive__get-file"],
  ["read a google doc", "google-drive__read-file-content"],
  ["read file content", "google-drive__read-file-content"],
  ["create a folder in drive", "google-drive__create-folder"],
  ["move a file to a folder", "google-drive__move-file"],
  ["rename a drive file", "google-drive__move-file"],
  ["share a file with a person", "google-drive__share-file"],
  // HubSpot's (GRA-254), each also pinned over HubSpot's tools alone in `tool-index.test.ts`.
  ["look up a contact by email", "hubspot__find-contact"],
  ["search deals", "hubspot__find-deal"],
  ["get a deal with its contacts", "hubspot__get-record"],
  ["list hubspot owners", "hubspot__list-owners"],
  ["list pipeline stages", "hubspot__list-pipelines"],
  ["add a contact to hubspot", "hubspot__create-contact"],
  ["create a company", "hubspot__create-company"],
  ["create a deal", "hubspot__create-deal"],
  ["update a contact", "hubspot__update-record"],
  ["log a note on a deal", "hubspot__add-note"],
  ["create a task", "hubspot__create-task"],
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

describe("the stock catalogue answers a person's words (GRA-250)", () => {
  it.each(CASES)('"%s" finds %s first', (query, wire) => {
    const found = searchTools(catalogue, query, { vendorNames: VENDOR_NAMES });
    expect(found.hits[0]?.wire).toBe(wire);
  });

  // Recorded, not yet right: "find a file" ranks get-file above search-files, because get-file's
  // `fileId` input label scores "file" again and "find" reaches both names only as a synonym. The
  // ranking is the index's (GRA-225), not the tool's; flip this when the index learns it.
  it('"find a file in drive" reaches search-files, below get-file for now', () => {
    const found = searchTools(catalogue, "find a file in drive", { vendorNames: VENDOR_NAMES });
    expect(found.hits.slice(0, 2).map((hit) => hit.wire)).toEqual([
      "google-drive__get-file",
      "google-drive__search-files",
    ]);
  });

  it("covers every stock tool with a query", () => {
    const covered = new Set(CASES.map(([, wire]) => wire));
    expect(catalogue.map((tool) => tool.wire).filter((wire) => !covered.has(wire))).toEqual([]);
  });
});
