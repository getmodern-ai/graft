import { describe, expect, it } from "vitest";

import {
  COVERAGE_THRESHOLD,
  contentWords,
  goalCoverage,
  goalWrites,
  SIMILAR_THRESHOLD,
  similarity,
  similarTools,
} from "./acquire-similar";

/**
 * The toolbox of 2026-09-21 and the four goals a Hermes agent sent that day (GRA-154). The first
 * goal was built although two tools already covered it; the other three had no match and must
 * have none here, whatever vocabulary they share with the vendor's other tools.
 */
const gmail = (name: string, description: string, readOnly: boolean) => ({
  vendor: "gmail",
  name,
  description,
  readOnly,
});
const FIND_INVOICES = gmail(
  "find-invoices",
  "Finds up to 20 matching Gmail messages and returns sender, subject, received date, and a short snippet for each.",
  true,
);
const LIST_EMAILS = gmail(
  "list-recent-inbox-emails",
  "Lists the 5 most recent emails in the Gmail inbox, showing the sender, subject, date, and a short snippet for each.",
  true,
);
const LIST_MESSAGES = gmail(
  "list-recent-inbox-messages",
  "Lists the most recent Gmail inbox messages, showing the sender, subject, date, and a short snippet for each. Returns 5 messages by default and accepts a count up to 50.",
  true,
);
const CREATE_DRAFT = gmail(
  "create-threaded-reply-draft",
  "Creates a plain-text Gmail reply draft in an existing thread without sending it.",
  false,
);
const GET_DRAFT = gmail(
  "get-draft",
  "Retrieves a Gmail draft by draft ID and returns its draft ID, thread ID, To, Cc, Subject, and decoded plain-text body.",
  true,
);
const TOOLBOX = [FIND_INVOICES, LIST_EMAILS, LIST_MESSAGES, CREATE_DRAFT, GET_DRAFT];

const GOALS = {
  listFive:
    "Retrieve the five most recent emails in the connected Gmail inbox, including sender, subject, received time, and a short body preview.",
  unreplied:
    "Find the 20 most recent Gmail inbox threads where the latest message is inbound and there is no later message sent by the mailbox owner. Return the thread ID, message ID, sender, recipients, subject, received time, and decoded plain-text body of the latest message so the agent can decide which genuinely need a reply. Read-only.",
  createDraft:
    "Create a Gmail reply draft in an existing thread without sending it. Accept thread ID, original message ID, recipient address, subject, and plain-text body. Preserve threading with the correct threadId, In-Reply-To, References, and RFC 2822 message headers. Return the created draft ID and message metadata.",
  getDraft:
    "Retrieve a Gmail draft by draft ID and return its draft ID, thread ID, To, Cc, Subject, and decoded plain-text body. Read-only.",
};

describe("similarTools", () => {
  it("names the two listing tools the agent built a third copy of, best first", () => {
    expect(similarTools(TOOLBOX, GOALS.listFive).map((t) => t.name)).toEqual([
      "list-recent-inbox-emails",
      "list-recent-inbox-messages",
    ]);
    expect(similarity(GOALS.listFive, LIST_EMAILS)).toBeGreaterThan(SIMILAR_THRESHOLD);
  });

  it("names nothing for the three goals no tool covered, whatever words they share with the vendor's others", () => {
    // Each goal against the toolbox as it stood before its own tool was built.
    const before: [string, (typeof TOOLBOX)[number] | null][] = [
      [GOALS.unreplied, null],
      [GOALS.createDraft, CREATE_DRAFT],
      [GOALS.getDraft, GET_DRAFT],
    ];
    for (const [goal, own] of before) {
      expect(
        similarTools(
          TOOLBOX.filter((tool) => tool !== own),
          goal,
        ),
        goal,
      ).toEqual([]);
    }
    // The nearest miss of the day, so a change to the rule is measured against it.
    expect(similarity(GOALS.unreplied, FIND_INVOICES)).toBeLessThan(SIMILAR_THRESHOLD);
  });

  it("finds a tool that is the goal, and keeps a read goal and a write tool apart", () => {
    expect(similarTools(TOOLBOX, GOALS.getDraft).map((t) => t.name)).toEqual(["get-draft"]);
    // get-draft and create-threaded-reply-draft share most of their words; the verb tells them apart.
    expect(goalWrites(GOALS.createDraft)).toBe(true);
    expect(goalWrites(GOALS.getDraft)).toBe(false);
    expect(similarTools([CREATE_DRAFT], GOALS.getDraft)).toEqual([]);
    expect(similarTools([GET_DRAFT], GOALS.createDraft)).toEqual([]);
    // A write named later in the goal still makes it a write goal (Greptile on #122).
    const listThenDelete = "List items from Demo Orders and then delete the selected item";
    expect(goalWrites(listThenDelete)).toBe(true);
    expect(
      similarTools(
        [
          {
            vendor: "demo",
            name: "list-items",
            description: "Lists items from Demo Orders.",
            readOnly: true,
          },
        ],
        listThenDelete,
      ),
    ).toEqual([]);
    // A verb with a noun sense counts when it leads the goal and not otherwise: "Mark the message
    // read" and "Reply to the latest email" write; a goal about mail to reply to reads.
    expect(goalWrites("Mark the message read")).toBe(true);
    expect(goalWrites("Add a label to the newest message")).toBe(true);
    expect(goalWrites("Reply to the latest email in the thread")).toBe(true);
    expect(goalWrites(GOALS.unreplied)).toBe(false);
    // Words that are nouns as often as verbs when they lead — open, book, close — are not writes.
    expect(goalWrites("Open invoices for the current month")).toBe(false);
    expect(goalWrites("Book details for this order")).toBe(false);
    // With no annotation the words alone decide.
    expect(
      similarTools(
        [
          {
            vendor: "demo",
            name: "list-items",
            description: "Lists items from Demo Orders, up to a limit.",
          },
        ],
        "List the items in Demo Orders",
      ).map((t) => t.name),
    ).toEqual(["list-items"]);
  });

  it("drops the words every goal uses and reads a name's hyphens as spaces", () => {
    expect(contentWords("Retrieve the five most recent emails, including the sender")).toEqual([
      "five",
      "most",
      "recent",
      "emails",
      "sender",
    ]);
    expect(contentWords("list-recent-inbox-emails")).toEqual(["list", "recent", "inbox", "emails"]);
    expect(similarity("", LIST_EMAILS)).toBe(0);
  });
});

/** Open-Meteo's stock tool as the catalogue holds it (GRA-238): a description written in full. */
const CURRENT_WEATHER = {
  vendor: "open-meteo",
  name: "current-weather",
  description:
    "Get the current weather in a city: looks the city up by name and answers its temperature, wind speed and weather code right now, with the units. Answers found: false when no place has that name.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  readOnly: true,
};

describe("similarTools over stock (GRA-243)", () => {
  it("finds a stock tool whose long description dilutes the overlap, by the goal's coverage", () => {
    const goal = "Get the current weather in a city";
    expect(similarity(goal, CURRENT_WEATHER)).toBeLessThan(SIMILAR_THRESHOLD);
    expect(goalCoverage(goal, CURRENT_WEATHER)).toBe(1);
    expect(similarTools([CURRENT_WEATHER], goal)).toEqual([CURRENT_WEATHER]);
    // A goal about something else at the vendor is not covered.
    expect(similarTools([CURRENT_WEATHER], "The hourly rain forecast for the next week")).toEqual(
      [],
    );
  });

  it("keeps the 2026-09-21 goals that matched nothing under the coverage threshold too", () => {
    for (const goal of [GOALS.unreplied, GOALS.getDraft]) {
      for (const tool of [FIND_INVOICES, LIST_EMAILS, LIST_MESSAGES]) {
        expect(goalCoverage(goal, tool), `${goal} / ${tool.name}`).toBeLessThan(COVERAGE_THRESHOLD);
      }
    }
  });

  it("ranks a toolbox tool the overlap finds before a stock tool only the coverage finds", () => {
    const own = {
      vendor: "open-meteo",
      name: "current-weather-city",
      description: "Current weather in a city.",
      readOnly: true,
    };
    expect(
      similarTools([CURRENT_WEATHER, own], "Current weather in a city").map((t) => t.name),
    ).toEqual(["current-weather-city", "current-weather"]);
  });
});
