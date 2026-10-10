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
  // Google Calendar's (GRA-249).
  ["list my calendars", "google-calendar__list-calendars"],
  ["show my calendar", "google-calendar__list-calendars"],
  ["what is on my calendar this week", "google-calendar__list-events"],
  ["list calendar events", "google-calendar__list-events"],
  ["upcoming events", "google-calendar__list-events"],
  ["get event", "google-calendar__get-event"],
  ["event details", "google-calendar__get-event"],
  ["find free time", "google-calendar__find-free-time"],
  ["free slots", "google-calendar__find-free-time"],
  ["check availability", "google-calendar__find-free-time"],
  ["create event", "google-calendar__create-event"],
  ["schedule a meeting", "google-calendar__create-event"],
  ["book a meeting", "google-calendar__create-event"],
  ["invite people to a meeting", "google-calendar__create-event"],
  ["update event", "google-calendar__update-event"],
  ["reschedule a meeting", "google-calendar__update-event"],
  ["move an event", "google-calendar__update-event"],
  ["delete event", "google-calendar__delete-event"],
  ["cancel a meeting", "google-calendar__delete-event"],
  ["accept invitation", "google-calendar__respond-to-event"],
  ["decline an invite", "google-calendar__respond-to-event"],
  ["rsvp", "google-calendar__respond-to-event"],
  // Slack's (GRA-251), also pinned in tool-index.test.ts.
  ["list slack channels", "slack__list-channels"],
  ["slack channel history", "slack__read-channel-history"],
  ["read a slack thread", "slack__read-thread"],
  ["find a slack user by email", "slack__find-user"],
  ["post a message to a slack channel", "slack__post-message"],
  ["reply in a slack thread", "slack__reply-in-thread"],
  ["send a direct message on slack", "slack__send-direct-message"],
  ["add a reaction", "slack__add-reaction"],
  // GitHub's (GRA-253), also pinned in tool-index.test.ts.
  ["my github repos", "github__list-my-repositories"],
  ["list issues", "github__list-issues"],
  ["get issue with comments", "github__get-issue"],
  ["search pull requests", "github__search-issues-and-pull-requests"],
  ["list pull requests", "github__list-pull-requests"],
  ["pull request changed files", "github__get-pull-request"],
  ["read a file from a github repo", "github__get-file-contents"],
  ["create issue", "github__create-issue"],
  ["comment on pull request", "github__comment-on-issue-or-pull-request"],
  ["close issue", "github__update-issue"],
  ["create pull request", "github__create-pull-request"],
  // Gmail's (GRA-248), also pinned over Gmail's tools alone in tool-index.test.ts.
  ["search my email", "gmail__search-messages"],
  ["read an email", "gmail__get-message"],
  ["read a gmail conversation", "gmail__get-thread"],
  ["list gmail labels", "gmail__list-labels"],
  ["send an email", "gmail__send-email"],
  ["draft an email", "gmail__create-draft"],
  ["reply to an email", "gmail__reply-to-thread"],
  ["archive an email", "gmail__modify-labels"],
  // Google Sheets' (GRA-259).
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
  // Stripe's (GRA-261).
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
