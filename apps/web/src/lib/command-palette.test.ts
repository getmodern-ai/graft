import { describe, expect, it } from "vitest";

import {
  filterPalette,
  isCommandPaletteShortcut,
  NAVIGATION_ITEMS,
  type PaletteItem,
} from "./command-palette";
import { SCREEN_NAV_ITEMS } from "./main-sidebar-nav-items";

const labels = (query: string) =>
  filterPalette(NAVIGATION_ITEMS, query).flatMap((group) => group.items.map((item) => item.label));

describe("NAVIGATION_ITEMS", () => {
  it("lists the sidebar's screens, in its order", () => {
    expect(NAVIGATION_ITEMS.map((item) => item.to)).toEqual(
      SCREEN_NAV_ITEMS.map((item) => item.to),
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
  });

  it("omits a group with nothing left, so no heading stands over an empty list", () => {
    expect(filterPalette(NAVIGATION_ITEMS, "nothing matches this")).toEqual([]);
  });

  it("draws groups in the palette's order and rows in the order they came", () => {
    const rows: PaletteItem[] = [
      { id: "b", group: "Go to", label: "Beta", keywords: [], to: "/settings" },
      { id: "a", group: "Go to", label: "Alpha", keywords: [], to: "/agents" },
    ];
    expect(filterPalette(rows, "").map((group) => group.items.map((item) => item.id))).toEqual([
      ["b", "a"],
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
