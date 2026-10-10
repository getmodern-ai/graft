import { STARTER_VENDORS } from "@graft/core";
import { readStockWorkspace } from "@graft/stock";
import { describe, expect, it } from "vitest";

import {
  FIND_TOOL_LIMIT,
  type IndexedTool,
  inputLabels,
  queryTerms,
  queryWords,
  searchTools,
  stem,
} from "./tool-index";

const tool = (
  vendor: string,
  name: string,
  description: string,
  extra: Partial<IndexedTool> = {},
): IndexedTool => ({ vendor, name, description, ...extra });

const names = (hits: { hits: IndexedTool[] }) => hits.hits.map((hit) => hit.name);

/**
 * GRA-221's queries, against tools named as the starter integrations' basics are named in that
 * write-up (`docs/research/gra-221-pipedream-coverage.md` on `research/gra-221-pipedream-coverage`,
 * its search section): each of these found the wrong tool, or none, under the all-words rule.
 */
const hubspot = {
  searchCrm: tool("hubspot", "search-crm", "Search a CRM object type by a single property.", {
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: ["contacts", "companies", "deals", "tickets"] },
        searchProperty: { type: "string" },
        searchValue: { type: "string" },
      },
    },
  }),
  createObject: tool(
    "hubspot",
    "create-crm-object",
    "Create a CRM object. Use find tools first to avoid duplicates.",
    {
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string", enum: ["contacts", "companies", "deals", "tickets"] },
        },
      },
    },
  ),
  listOwners: tool("hubspot", "list-owners", "Lists the owners in the HubSpot account.", {
    readOnly: true,
  }),
};
const slack = {
  sendToUser: tool(
    "slack",
    "send-message-to-user-or-group",
    "Send a message to a user or a group of users.",
    { readOnly: false },
  ),
  listChannels: tool("slack", "list-channels", "Lists the channels in the workspace.", {
    readOnly: true,
  }),
  findUser: tool("slack", "find-user-by-email", "Finds a Slack user by their email address.", {
    readOnly: true,
  }),
};
const github = {
  searchIssues: tool(
    "github",
    "search-issues-and-pull-requests",
    "Searches the issues and pull requests of a repository.",
    { readOnly: true },
  ),
  listMilestones: tool(
    "github",
    "list-milestones",
    "Lists the milestones of a repository, each with its open issues count.",
    { readOnly: true },
  ),
  createIssue: tool("github", "create-issue", "Creates an issue in a repository.", {
    readOnly: false,
  }),
};
const unleashed = {
  productOptions: tool(
    "unleashed",
    "list-product-id-options",
    "Lists the products of the Unleashed account with their ids.",
    { readOnly: true },
  ),
  stockAdjustment: tool(
    "unleashed",
    "create-stock-adjustment",
    "Creates a stock adjustment for a product.",
    { readOnly: false },
  ),
};
const CATALOGUE = [
  ...Object.values(hubspot),
  ...Object.values(slack),
  ...Object.values(github),
  ...Object.values(unleashed),
];

describe("the real queries (GRA-221)", () => {
  it('"find a contact" reaches the CRM search through its input labels, read-only above the write', () => {
    const found = searchTools(CATALOGUE, "find a contact");
    expect(names(found)).toEqual(["search-crm", "create-crm-object"]);
  });

  it('"send dm" finds the message tool', () => {
    expect(names(searchTools(CATALOGUE, "send dm"))).toEqual(["send-message-to-user-or-group"]);
  });

  it('"list issues" ranks the search over a lister that only mentions issues', () => {
    expect(names(searchTools(CATALOGUE, "list issues"))).toEqual([
      "search-issues-and-pull-requests",
      "list-milestones",
    ]);
  });

  it('"list products" finds the singular name', () => {
    expect(names(searchTools(CATALOGUE, "list products"))[0]).toBe("list-product-id-options");
  });

  it('"look up a user" reads "look up" as a search', () => {
    expect(names(searchTools(CATALOGUE, "look up a user"))).toEqual(["find-user-by-email"]);
  });

  it("matches the integration's display name as a boost", () => {
    const vendorNames = new Map([["hubspot", ["HubSpot CRM"]]]);
    const found = searchTools(CATALOGUE, "crm owners", { vendorNames });
    expect(names(found)).toEqual(["list-owners"]);
  });
});

describe("ranking", () => {
  it("puts the agent's working set first, then the rest by score", () => {
    const strong = tool("demo", "list-items", "List items.", { tier: 1 });
    const weak = tool("demo", "ping", "Pings, and lists nothing but items.", { tier: 0 });
    expect(names(searchTools([strong, weak], "items"))).toEqual(["ping", "list-items"]);
  });

  it("puts read-only tools first for a read verb, and not otherwise", () => {
    const write = tool(
      "demo",
      "create-contact",
      "Creates a contact, or finds the one that exists.",
      {
        readOnly: false,
      },
    );
    const read = tool("demo", "contact-details", "Looks up a contact.", { readOnly: true });
    expect(names(searchTools([write, read], "find contact"))).toEqual([
      "contact-details",
      "create-contact",
    ]);
    // No read verb: the name hit on "create" decides.
    expect(names(searchTools([read, write], "create contact"))).toEqual(["create-contact"]);
  });

  it("answers the first five and counts the rest as more", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      tool("demo", `list-items-${String.fromCharCode(97 + i)}`, "List items."),
    );
    const found = searchTools(many, "items");
    expect(FIND_TOOL_LIMIT).toBe(5);
    expect(found.hits).toHaveLength(5);
    expect(found.more).toBe(3);
    expect(names(found)[0]).toBe("list-items-a");
    expect(searchTools(many.slice(0, 2), "items").more).toBe(0);
    expect(searchTools(many, "items", { limit: 2 }).more).toBe(6);
  });
});

/** The all-words cases GRA-115 pinned, which the index keeps. */
describe("every query concept must hit (GRA-115)", () => {
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
  const hits = (t: IndexedTool, query: string) => searchTools([t], query).hits.length === 1;

  it("matches every word in any order across vendor, name and description", () => {
    expect(hits(rates, "exchange rate")).toBe(true);
    expect(hits(rates, "rate exchange")).toBe(true);
    expect(hits(gmailAttachment, "gmail attachment")).toBe(true);
    expect(hits(gmailAttachment, "latest email attachment")).toBe(false);
    expect(hits(gmailAttachment, "latest attachment message")).toBe(true);
  });

  it("reads a hyphenated name, and the wire name, as words", () => {
    expect(hits(gmailAttachment, "get latest attachment")).toBe(true);
    expect(hits(items, "list-items")).toBe(true);
    expect(hits(items, "demo__list-items")).toBe(true);
  });

  it("hits on the vendor alone, and on words drawn from different fields", () => {
    expect(hits(ping, "other")).toBe(true);
    expect(hits(rates, "frankfurter currency")).toBe(true);
  });

  it("is a miss when any word is absent, and never a hit on an empty query", () => {
    expect(hits(rates, "exchange rate gmail")).toBe(false);
    expect(hits(items, "items nowhere")).toBe(false);
    expect(hits(items, "")).toBe(false);
    expect(hits(items, "x")).toBe(false);
  });

  it("is case-insensitive, and a word of four or more characters hits as a prefix", () => {
    expect(hits(items, "ITEMS")).toBe(true);
    expect(hits(gmailAttachment, "attach")).toBe(true);
    expect(hits(gmailAttachment, "att")).toBe(false);
  });

  it("ranks a name hit above a vendor hit above a description hit, then by name", () => {
    const byDescriptionOnly = tool("acme", "fetch-thing", "Reads the latest thing from Acme.");
    const byVendorOnly = tool("latest", "read-record", "Reads a record.");
    expect(names(searchTools([byDescriptionOnly, byVendorOnly, rates], "latest"))).toEqual([
      "latest-rates",
      "read-record",
      "fetch-thing",
    ]);
    const zebra = tool("demo", "zebra-items", "List items.");
    const apple = tool("demo", "apple-items", "List items.");
    expect(names(searchTools([zebra, apple], "items"))).toEqual(["apple-items", "zebra-items"]);
  });
});

describe("queryWords and queryTerms", () => {
  it("splits on whitespace and punctuation, lowercases, drops one-character words and duplicates", () => {
    expect(queryWords("  Gmail, attachment!  ")).toEqual(["gmail", "attachment"]);
    expect(queryWords("demo__list-items")).toEqual(["demo", "list", "items"]);
    expect(queryWords("rate rate RATE")).toEqual(["rate"]);
    expect(queryWords("!!! - _")).toEqual([]);
  });

  it("counts a one-character word in code points (Greptile on #91)", () => {
    expect(queryWords("𐐷")).toEqual([]);
    expect(queryWords("𐐷𐐷 items")).toEqual(["𐐷𐐷", "items"]);
  });

  it("stems, drops function words, and keeps them when nothing else is left", () => {
    expect(queryTerms("find a contact for me")).toEqual(["find", "contact"]);
    expect(queryTerms("list the issues")).toEqual(["list", "issu"]);
    expect(queryTerms("their")).toEqual(["their"]);
  });
});

describe("stem", () => {
  it("folds plurals and -ing/-ed forms onto one stem", () => {
    const same = (...words: string[]) => new Set(words.map(stem)).size === 1;
    expect(same("contact", "contacts")).toBe(true);
    expect(same("issue", "issues")).toBe(true);
    expect(same("create", "creates", "created", "creating")).toBe(true);
    expect(same("search", "searches", "searching", "searched")).toBe(true);
    expect(same("reply", "replies", "replied")).toBe(true);
    expect(same("message", "messages")).toBe(true);
    expect(same("list", "lists", "listing")).toBe(true);
    expect(same("add", "added", "adding")).toBe(true);
    expect(same("run", "running")).toBe(true);
    expect(same("box", "boxes")).toBe(true);
    expect(stem("status")).toBe("status");
    expect(stem("address")).toBe("address");
  });
});

describe("inputLabels", () => {
  it("reads property names split at case, titles, and enum values, nested and in lists", () => {
    expect(
      inputLabels({
        type: "object",
        properties: {
          objectType: { type: "string", title: "Object kind", enum: ["contacts", 3] },
          page_size: { type: "integer" },
          filters: {
            type: "array",
            items: { type: "object", properties: { fieldName: { type: "string" } } },
          },
        },
      }),
    ).toEqual(["object type", "object kind", "contacts", "page size", "filters", "field name"]);
    expect(inputLabels({ type: "object" })).toEqual([]);
    expect(inputLabels(undefined)).toEqual([]);
  });
});

/**
 * The stock catalogue as the boot reads it (`packages/stock/tools/`): each stock tool must be the
 * first hit for the words a person would use for it, among every stock tool. One block per
 * integration's basics; Slack's are GRA-251's.
 */
describe("the stock catalogue's real queries", async () => {
  const workspace = await readStockWorkspace();
  const stock: IndexedTool[] = workspace.map((t) => ({
    vendor: t.vendor,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    readOnly: t.annotations.readOnly,
  }));
  const vendorNames = new Map([["slack", ["Slack"]]]);
  const first = (query: string) => {
    const hit = searchTools(stock, query, { vendorNames }).hits[0];
    return hit ? `${hit.vendor}__${hit.name}` : null;
  };

  it.each([
    ["list slack channels", "slack__list-channels"],
    ["show me the channels", "slack__list-channels"],
    ["read the messages in a channel", "slack__read-channel-history"],
    ["slack channel history", "slack__read-channel-history"],
    ["read a slack thread", "slack__read-thread"],
    ["read the replies in a thread", "slack__read-thread"],
    ["find a slack user by email", "slack__find-user"],
    ["look up a person in slack", "slack__find-user"],
    ["post a message to a slack channel", "slack__post-message"],
    ["reply in thread", "slack__reply-in-thread"],
    ["send dm", "slack__send-direct-message"],
    ["send a direct message on slack", "slack__send-direct-message"],
    ["add a reaction", "slack__add-reaction"],
    ["react with an emoji", "slack__add-reaction"],
  ])('"%s" finds %s first', (query, wire) => {
    expect(first(query)).toBe(wire);
  });
});

/**
 * HubSpot's stock tools as they ship (GRA-254): each is found first by a query a person would use
 * for it, searched over every stock tool at once with the integrations' display names, as
 * `find_tool` searches them (`meta.ts`).
 */
describe("HubSpot's stock tools (GRA-254)", () => {
  const vendorNames = new Map(
    STARTER_VENDORS.map((starter) => [starter.vendor, [starter.displayName]]),
  );
  const QUERIES: [query: string, wire: string][] = [
    ["find a contact", "hubspot__find-contact"],
    ["look up a contact by email", "hubspot__find-contact"],
    ["search hubspot contacts", "hubspot__find-contact"],
    ["find a deal", "hubspot__find-deal"],
    ["search deals", "hubspot__find-deal"],
    ["get a deal with its contacts", "hubspot__get-record"],
    ["list owners", "hubspot__list-owners"],
    ["list hubspot owners", "hubspot__list-owners"],
    ["list pipelines", "hubspot__list-pipelines"],
    ["list pipeline stages", "hubspot__list-pipelines"],
    ["show deal pipelines", "hubspot__list-pipelines"],
    ["create a contact", "hubspot__create-contact"],
    ["add a contact to hubspot", "hubspot__create-contact"],
    ["create a company", "hubspot__create-company"],
    ["create a deal", "hubspot__create-deal"],
    ["move a deal to another stage", "hubspot__update-record"],
    ["update a contact", "hubspot__update-record"],
    ["add a note to a contact", "hubspot__add-note"],
    ["log a note on a deal", "hubspot__add-note"],
    ["create a task", "hubspot__create-task"],
    ["remind me to call a contact", "hubspot__create-task"],
  ];

  it.each(QUERIES)('"%s" finds %s first', async (query, wire) => {
    const tools = (await readStockWorkspace()).map((tool) => ({
      vendor: tool.vendor,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: tool.annotations.readOnly,
    }));
    const [first] = searchTools(tools, query, { vendorNames }).hits;
    expect(first && `${first.vendor}__${first.name}`).toBe(wire);
  });
});
