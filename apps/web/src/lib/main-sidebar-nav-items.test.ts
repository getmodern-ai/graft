import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "./main-sidebar-nav-items";

describe("NAV_ITEMS", () => {
  it("names the four destinations in the order the sidebar draws them", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Agents",
      "Pending actions",
      "Connections",
      "Settings",
    ]);
  });

  // A row whose `match` does not prefix its own `to` would never light on the screen it opens.
  it("lights each row on the screen it opens", () => {
    for (const item of NAV_ITEMS) {
      expect(item.to.startsWith(item.match)).toBe(true);
    }
  });

  // Two rows sharing a prefix would both light on one screen.
  it("gives every row its own prefix", () => {
    const matches = NAV_ITEMS.map((item) => item.match);
    for (const match of matches) {
      expect(matches.filter((other) => other.startsWith(match))).toHaveLength(1);
    }
  });
});
