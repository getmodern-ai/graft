import { describe, expect, it } from "vitest";

import {
  DOCS_NAV_ITEM,
  FOOTER_NAV_ITEMS,
  isNavItemActive,
  NAV_ITEMS,
  SCREEN_NAV_ITEMS,
} from "./main-sidebar-nav-items";

describe("NAV_ITEMS", () => {
  it("names the main group's destinations in the order the sidebar draws them", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Home",
      "Requests",
      "Agents",
      "Integrations",
      "Activity",
    ]);
  });

  it("puts Home at the root and Integrations on the integrations list", () => {
    expect(NAV_ITEMS.map((item) => item.to)).toEqual([
      "/",
      "/pending",
      "/agents",
      "/integrations",
      "/activity",
    ]);
  });

  it("puts Settings in the footer, under the docs link", () => {
    expect(FOOTER_NAV_ITEMS.map((item) => item.label)).toEqual(["Settings"]);
    expect(DOCS_NAV_ITEM.label).toBe("Docs & help");
    expect(DOCS_NAV_ITEM.href).toMatch(/^https:\/\//);
  });

  // A row that does not light on the screen it opens would leave the person unplaced.
  it("lights each row on the screen it opens", () => {
    for (const item of SCREEN_NAV_ITEMS) {
      expect(isNavItemActive(item, item.to)).toBe(true);
    }
  });

  // Two rows lit on one screen would say the person is in two places.
  it("lights exactly one row on every screen and its detail screens", () => {
    const paths = SCREEN_NAV_ITEMS.flatMap((item) =>
      item.exact ? [item.to] : [item.to, `${item.to}/some-id`],
    );
    for (const path of paths) {
      expect(SCREEN_NAV_ITEMS.filter((item) => isNavItemActive(item, path))).toHaveLength(1);
    }
  });
});

describe("isNavItemActive", () => {
  const home = NAV_ITEMS.find((item) => item.to === "/");
  const agents = NAV_ITEMS.find((item) => item.to === "/agents");
  if (!home || !agents) throw new Error("the nav list lost Home or Agents");

  it("lights Home on the root alone", () => {
    expect(isNavItemActive(home, "/")).toBe(true);
    expect(isNavItemActive(home, "/agents")).toBe(false);
  });

  it("keeps a section lit on its detail screens", () => {
    expect(isNavItemActive(agents, "/agents/agt_1")).toBe(true);
  });

  it("does not light a section on a path that merely starts with its name", () => {
    expect(isNavItemActive(agents, "/agentsx")).toBe(false);
  });

  it("lights nothing on a screen outside the sidebar", () => {
    expect(SCREEN_NAV_ITEMS.some((item) => isNavItemActive(item, "/setup"))).toBe(false);
  });
});
