import { describe, expect, it } from "vitest";

import {
  accessOptions,
  connectButtonLabel,
  connectedVendors,
  connectStepSentence,
  customApiSeed,
  discoverPlaceholder,
  readDiscoverSearch,
  resultsHeading,
  suggestionConnect,
  suggestionCustom,
  suggestionLine,
} from "./integrations-discover";

/**
 * The Discover tab (GRA-322): what the search box means, what a suggestion says and does, and what
 * Flow C is handed.
 */

const NOW = new Date("2026-10-14T12:00:00Z");

const suggestion = (state: "open" | "declined" | "expired", askedAt = "2026-10-11T12:00:00Z") => ({
  vendor: "notion",
  displayName: "Notion",
  docsUrl: null as string | null,
  agent: { id: "agt_1", name: "Claude" },
  ask: { pendingActionId: "pa_1", state, askedAt, ageSeconds: 0 },
});

describe("readDiscoverSearch", () => {
  it("browses when empty and searches words", () => {
    expect(readDiscoverSearch("   ")).toEqual({ kind: "browse" });
    expect(readDiscoverSearch(" acme unleashed ")).toEqual({
      kind: "search",
      query: "acme unleashed",
    });
  });

  it("reads a pasted link as docs for Flow C, with or without its scheme", () => {
    expect(readDiscoverSearch("https://docs.acme.dev/api")).toEqual({
      kind: "docs",
      url: "https://docs.acme.dev/api",
    });
    expect(readDiscoverSearch("docs.acme.dev/reference")).toEqual({
      kind: "docs",
      url: "https://docs.acme.dev/reference",
    });
    expect(readDiscoverSearch("www.acme.dev")).toEqual({
      kind: "docs",
      url: "https://www.acme.dev",
    });
  });

  it("keeps searching a name with a dot, a scheme with no host, and words around a link", () => {
    expect(readDiscoverSearch("cal.com")).toEqual({ kind: "search", query: "cal.com" });
    expect(readDiscoverSearch("https://localhost")).toEqual({
      kind: "search",
      query: "https://localhost",
    });
    expect(readDiscoverSearch("see https://acme.dev")).toEqual({
      kind: "search",
      query: "see https://acme.dev",
    });
  });
});

describe("discoverPlaceholder", () => {
  it("names the directory's own count, and none before it loads", () => {
    expect(discoverPlaceholder(3224)).toBe(
      "Search 3,224 integrations, or paste a link to any API docs",
    );
    expect(discoverPlaceholder(1)).toBe("Search 1 integration, or paste a link to any API docs");
    expect(discoverPlaceholder(undefined)).toBe(
      "Search integrations, or paste a link to any API docs",
    );
  });
});

describe("suggestions", () => {
  it("say which agent asked and nothing it was asked", () => {
    expect(suggestionLine(suggestion("open"), NOW)).toBe("Claude is waiting on this one");
    expect(suggestionLine(suggestion("declined"), NOW)).toBe("Claude asked for it 3 days ago");
    expect(suggestionLine(suggestion("expired", "2026-10-13T12:00:00Z"), NOW)).toBe(
      "Claude asked for it yesterday",
    );
  });

  it("answer an open ask on its request, and connect a closed one through the directory", () => {
    expect(suggestionConnect(suggestion("open"))).toEqual({
      kind: "request",
      pendingActionId: "pa_1",
    });
    expect(suggestionConnect(suggestion("declined"))).toEqual({
      kind: "directory",
      slug: "notion",
    });
  });

  it("hand Flow C the ask's docs, else its name", () => {
    expect(suggestionCustom(suggestion("expired"))).toBe("Notion");
    expect(
      suggestionCustom({ ...suggestion("expired"), docsUrl: "https://developers.notion.com" }),
    ).toBe("https://developers.notion.com");
  });
});

describe("customApiSeed", () => {
  it("reads a link as the docs and anything else as the name", () => {
    expect(customApiSeed("https://docs.acme.dev")).toEqual({
      name: "",
      docsUrl: "https://docs.acme.dev/",
    });
    expect(customApiSeed(" acme unleashed ")).toEqual({ name: "acme unleashed", docsUrl: null });
  });
});

describe("the connect dialog", () => {
  it("offers Full access first, and says what Full access covers", () => {
    const options = accessOptions("Notion");
    expect(options.map((option) => option.value)).toEqual(["full", "ask"]);
    expect(options[0]?.label).toBe("Full access");
    expect(options[0]?.description).toContain("Tools that can delete still ask");
    expect(options[1]?.label).toBe("Ask me first");
  });

  it("says what connecting takes, by how the directory connects it", () => {
    expect(connectButtonLabel({ name: "Notion", connect: "link" })).toBe("Sign in with Notion");
    expect(connectButtonLabel({ name: "Open-Meteo", connect: "keyless" })).toBe("Connect");
    expect(connectButtonLabel({ name: "Acme", connect: "form" })).toBe("Continue");
    expect(connectButtonLabel({ name: "Linear" })).toBe("Connect");
    expect(connectStepSentence({ name: "Linear", connect: null })).toBe(
      "Choose what your agents can do with Linear, then connect it.",
    );
    expect(connectStepSentence({ name: "Acme", connect: "form" })).toBe(
      "Next, add your Acme key. It is entered once and never shown again.",
    );
  });
});

describe("the grid", () => {
  it("knows the connected vendors and heads a search by its count", () => {
    expect(connectedVendors([{ vendor: "gmail" }, { vendor: "gmail" }])).toEqual(
      new Set(["gmail"]),
    );
    expect(resultsHeading("", null, 10)).toBe("Popular");
    expect(resultsHeading("", "CRM", 10)).toBe("CRM");
    expect(resultsHeading("slack", null, 1)).toBe("1 integration matches “slack”");
    expect(resultsHeading("goo", "CRM", 3)).toBe("3 integrations match “goo”");
  });
});
