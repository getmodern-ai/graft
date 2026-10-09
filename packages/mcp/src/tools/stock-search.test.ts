import { STARTER_VENDORS } from "@graft/core";
import { readStockWorkspace } from "@graft/stock";
import { describe, expect, it } from "vitest";

import { searchTools } from "./tool-index";

/**
 * The stock workspace's own tools, searched as `find_tool` searches them (`tools/meta.ts`: stock on
 * a connected integration at tier 2, the starters' display names as vendor boosts), by the words a
 * person would use. Each case is the query a stock tool's build ticket pinned (GRA-249 onward):
 * the tool must be the first hit, so a description edited later cannot quietly lose its query.
 */

const VENDOR_NAMES = new Map(
  STARTER_VENDORS.map((starter) => [starter.vendor, [starter.displayName]]),
);

const STOCK = (await readStockWorkspace()).map((tool) => ({
  vendor: tool.vendor,
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  readOnly: tool.annotations.readOnly,
  tier: 2,
}));

const first = (query: string): string | undefined => {
  const hit = searchTools(STOCK, query, { vendorNames: VENDOR_NAMES }).hits[0];
  return hit ? `${hit.vendor}__${hit.name}` : undefined;
};

/** GRA-249: Google Calendar's basics. */
const GOOGLE_CALENDAR: readonly (readonly [string, string])[] = [
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
];

describe("stock tools are found by the words a person uses", () => {
  it.each(GOOGLE_CALENDAR)('"%s" finds %s first', (query, tool) => {
    expect(first(query)).toBe(tool);
  });
});
