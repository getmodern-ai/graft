import { STARTER_VENDORS } from "@graft/core";
import { readStockWorkspace, type StockWorkspaceTool } from "@graft/stock";
import { beforeAll, describe, expect, it } from "vitest";

import { type IndexedTool, searchTools } from "./tool-index";

/**
 * The stock catalogue as shipped, searched by the words a person would use (ADR 0025; GRA-261):
 * each case is the query a person asks for one stock tool, and that tool must be the first hit
 * over the whole workspace, every vendor's tools together, with the integration's display name
 * as `find_tool` boosts it (`meta.ts`'s `VENDOR_NAMES`). A new stock tool adds its query here.
 */
const VENDOR_NAMES = new Map(STARTER_VENDORS.map((s) => [s.vendor, [s.displayName]]));

const CASES: [query: string, tool: string][] = [
  ["current weather", "open-meteo__current-weather"],
  ["find a customer", "stripe__find-customer"],
  ["look up a customer by email", "stripe__find-customer"],
  ["get a customer with their subscriptions", "stripe__get-customer"],
  ["list recent payments", "stripe__list-payments"],
  ["recent charges", "stripe__list-payments"],
  ["unpaid invoices", "stripe__list-invoices"],
  ["list invoices for a customer", "stripe__list-invoices"],
  ["get an invoice", "stripe__get-invoice"],
  ["show an invoice with its line items", "stripe__get-invoice"],
  ["list active subscriptions", "stripe__list-subscriptions"],
  ["canceled subscriptions", "stripe__list-subscriptions"],
  ["list products and prices", "stripe__list-products"],
  ["stripe balance", "stripe__get-balance"],
  ["how much money is in my stripe account", "stripe__get-balance"],
  ["create a customer", "stripe__create-customer"],
  ["add a new stripe customer", "stripe__create-customer"],
  ["create an invoice", "stripe__create-invoice"],
  ["send an invoice", "stripe__create-invoice"],
  ["refund a payment", "stripe__refund-payment"],
  ["refund a charge", "stripe__refund-payment"],
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

describe("the stock catalogue answers a person's words (GRA-261)", () => {
  it.each(CASES)('"%s" finds %s first', (query, wire) => {
    const found = searchTools(catalogue, query, { vendorNames: VENDOR_NAMES });
    expect(found.hits[0]?.wire).toBe(wire);
  });

  // HubSpot's queries are `tool-index.test.ts`'s (GRA-254); this file covers the vendors it names.
  it("covers every Stripe and Open-Meteo stock tool with a query", () => {
    const covered = new Set(CASES.map(([, wire]) => wire));
    const vendors = new Set(["stripe", "open-meteo"]);
    const mine = catalogue.filter((tool) => vendors.has(tool.vendor));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.map((tool) => tool.wire).filter((wire) => !covered.has(wire))).toEqual([]);
  });
});
