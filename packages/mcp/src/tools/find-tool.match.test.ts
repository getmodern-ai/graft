import { describe, expect, it } from "vitest";

import { matchesQuery, queryWords, rankTools } from "./find-tool.match";

const tool = (vendor: string, name: string, description: string) => ({
  vendor,
  name,
  description,
});

const gmailAttachment = tool(
  "google-workspace",
  "get-latest-attachment",
  "Downloads the newest attachment from the most recent Gmail message matching a search.",
);
const rates = tool(
  "frankfurter",
  "latest-rates",
  "Fetches the latest exchange rate for a base currency.",
);
const items = tool("demo", "list-items", "List items from Demo Orders.");
const ping = tool("other", "ping", "Ping the other vendor.");

describe("queryWords", () => {
  it("splits on whitespace and punctuation, lowercases, drops one-character words and duplicates", () => {
    expect(queryWords("  Gmail, attachment!  ")).toEqual(["gmail", "attachment"]);
    expect(queryWords("list-items")).toEqual(["list", "items"]);
    expect(queryWords("demo__list-items")).toEqual(["demo", "list", "items"]);
    expect(queryWords("a rate of X")).toEqual(["rate", "of"]);
    expect(queryWords("rate rate RATE")).toEqual(["rate"]);
  });

  it("is empty for a query with no word of two or more characters", () => {
    expect(queryWords("")).toEqual([]);
    expect(queryWords("   ")).toEqual([]);
    expect(queryWords("x")).toEqual([]);
    expect(queryWords("!!! - _")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("matches every word in any order across vendor, name and description", () => {
    expect(matchesQuery(rates, "exchange rate")).toBe(true);
    expect(matchesQuery(rates, "rate exchange")).toBe(true);
    expect(matchesQuery(gmailAttachment, "gmail attachment")).toBe(true);
    expect(matchesQuery(gmailAttachment, "latest email attachment")).toBe(false);
    expect(matchesQuery(gmailAttachment, "latest attachment message")).toBe(true);
  });

  it("reads a hyphenated name as words", () => {
    expect(matchesQuery(gmailAttachment, "latest attachment")).toBe(true);
    expect(matchesQuery(gmailAttachment, "get latest attachment")).toBe(true);
    expect(matchesQuery(items, "list items")).toBe(true);
    expect(matchesQuery(items, "list-items")).toBe(true);
  });

  it("hits on the vendor alone, and on words drawn from different fields", () => {
    expect(matchesQuery(ping, "other")).toBe(true);
    expect(matchesQuery(rates, "frankfurter")).toBe(true);
    // One word from the vendor, one from the description: the join is what is searched.
    expect(matchesQuery(rates, "frankfurter currency")).toBe(true);
  });

  it("is a miss when any word is absent, and never a hit on an empty word list", () => {
    expect(matchesQuery(rates, "exchange rate gmail")).toBe(false);
    expect(matchesQuery(items, "items nowhere")).toBe(false);
    expect(matchesQuery(items, "")).toBe(false);
    expect(matchesQuery(items, "x")).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchesQuery(items, "ITEMS")).toBe(true);
    expect(matchesQuery(gmailAttachment, "GMAIL")).toBe(true);
  });
});

describe("rankTools", () => {
  const byDescriptionOnly = tool("acme", "fetch-thing", "Reads the latest thing from Acme.");
  const byVendorOnly = tool("latest", "read-record", "Reads a record.");

  it("keeps the hits and drops the rest", () => {
    // Both carry "latest" in the name; the rates tool carries it in the description too.
    expect(rankTools([items, ping, gmailAttachment, rates], "latest")).toEqual([
      rates,
      gmailAttachment,
    ]);
    expect(rankTools([items, ping], "nowhere")).toEqual([]);
  });

  it("ranks a name hit above a vendor hit above a description hit", () => {
    // In toolbox order the description-only hit comes first; the rank puts it last.
    expect(rankTools([byDescriptionOnly, byVendorOnly, rates], "latest")).toEqual([
      rates,
      byVendorOnly,
      byDescriptionOnly,
    ]);
  });

  it("then by how many words hit the name, then by name", () => {
    // The same description on both, so the three tiers tie and the count of name hits decides.
    const oneNameHit = tool("demo", "list-things", "Items from Demo Orders.");
    const twoNameHits = tool("demo", "list-items", "Items from Demo Orders.");
    expect(rankTools([oneNameHit, twoNameHits], "list items")).toEqual([twoNameHits, oneNameHit]);
    const zebra = tool("demo", "zebra-items", "List items.");
    const apple = tool("demo", "apple-items", "List items.");
    expect(rankTools([zebra, apple], "items")).toEqual([apple, zebra]);
  });

  it("answers nothing for a query with no word to match on", () => {
    expect(rankTools([items, ping], "x")).toEqual([]);
    expect(rankTools([items, ping], "")).toEqual([]);
  });
});
