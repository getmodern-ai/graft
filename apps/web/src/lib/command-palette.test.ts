import { describe, expect, it } from "vitest";

import {
  ACTION_ITEMS,
  filterPalette,
  isCommandPaletteShortcut,
  NAVIGATION_ITEMS,
  PALETTE_GROUP_LIMITS,
  type PaletteItem,
  paletteMatchRank,
} from "./command-palette";
import { SCREEN_NAV_ITEMS } from "./main-sidebar-nav-items";

const labels = (query: string) =>
  filterPalette(NAVIGATION_ITEMS, query).flatMap((group) => group.items.map((item) => item.label));

describe("NAVIGATION_ITEMS", () => {
  it("lists the sidebar's screens, in its order", () => {
    expect(NAVIGATION_ITEMS.map((item) => item.open)).toEqual(
      SCREEN_NAV_ITEMS.map((item) => ({ to: item.to })),
    );
  });

  it("gives every row its own id", () => {
    const ids = NAVIGATION_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("filterPalette", () => {
  it("answers every row under its group for a blank query", () => {
    expect(filterPalette(NAVIGATION_ITEMS, "  ")).toEqual([
      { name: "Go to", items: [...NAVIGATION_ITEMS] },
    ]);
  });

  it("matches the start of a word of the label, ignoring case", () => {
    expect(labels("SET")).toEqual(["Settings"]);
    expect(labels("REQ")).toEqual(["Requests"]);
    expect(labels("tings")).toEqual([]);
  });

  it("needs every word of the query to match", () => {
    expect(labels("pen act")).toEqual(["Requests"]);
    expect(labels("pending agents")).toEqual([]);
  });

  it("matches the words a screen answers to beside its label", () => {
    expect(labels("pending")).toEqual(["Requests"]);
    expect(labels("conn")).toEqual(["Integrations"]);
    expect(labels("history")).toEqual(["Activity"]);
  });

  it("omits a group with nothing left, so no heading stands over an empty list", () => {
    expect(filterPalette(NAVIGATION_ITEMS, "nothing matches this")).toEqual([]);
  });

  it("draws groups in the palette's order and rows in the order they came", () => {
    const rows: PaletteItem[] = [
      { id: "b", group: "Go to", label: "Beta", keywords: [], open: { to: "/settings" } },
      { id: "a", group: "Go to", label: "Alpha", keywords: [], open: { to: "/agents" } },
    ];
    expect(filterPalette(rows, "").map((group) => group.items.map((item) => item.id))).toEqual([
      ["b", "a"],
    ]);
  });

  const row = (id: string, label: string, keywords: string[] = []): PaletteItem => ({
    id,
    group: "Tools",
    label,
    keywords,
    open: { to: "/integrations/$vendor", params: { vendor: "gmail" } },
  });

  it("ranks a label starting with the query, then label words, then keywords", () => {
    const rows = [
      row("keyword", "Find invoices", ["gmail"]),
      row("words", "Draft a Gmail reply"),
      row("prefix", "Gmail search"),
    ];
    expect(filterPalette(rows, "gmail")[0]?.items.map((item) => item.id)).toEqual([
      "prefix",
      "words",
      "keyword",
    ]);
  });

  it("caps a group once something is typed, never before", () => {
    const rows = Array.from({ length: 9 }, (_, index) => row(`t${index}`, `Tool ${index}`));
    expect(PALETTE_GROUP_LIMITS.Tools).toBe(4);
    expect(filterPalette(rows, "tool")[0]?.items).toHaveLength(4);
    expect(filterPalette(rows, "")[0]?.items).toHaveLength(9);
  });
});

describe("paletteMatchRank", () => {
  it("is null for a row the query does not answer", () => {
    expect(paletteMatchRank({ label: "Settings", keywords: ["model"] }, "tings")).toBeNull();
    expect(paletteMatchRank({ label: "Settings", keywords: ["model"] }, "mod")).toBe(2);
    expect(paletteMatchRank({ label: "Settings", keywords: [] }, "")).toBe(0);
  });
});

describe("ACTION_ITEMS", () => {
  it("connects an integration, an agent and an API by its docs", () => {
    expect(ACTION_ITEMS.map((item) => [item.label, item.open])).toEqual([
      ["Connect an integration", { to: "/integrations", search: { tab: "discover" } }],
      ["Connect another agent", { to: "/agents" }],
      ["Add a custom API", { to: "/integrations", search: { tab: "discover", custom: "" } }],
    ]);
  });
});

describe("isCommandPaletteShortcut", () => {
  const press = (overrides: Partial<Parameters<typeof isCommandPaletteShortcut>[0]>) => ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides,
  });

  it("takes ⌘K and Ctrl+K", () => {
    expect(isCommandPaletteShortcut(press({ metaKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(press({ ctrlKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(press({ key: "K", metaKey: true }))).toBe(true);
  });

  it("leaves a bare K, another letter, Shift or Alt with it, and a held key's repeats", () => {
    expect(isCommandPaletteShortcut(press({}))).toBe(false);
    expect(isCommandPaletteShortcut(press({ key: "b", metaKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(press({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(press({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(press({ metaKey: true, repeat: true }))).toBe(false);
  });
});
