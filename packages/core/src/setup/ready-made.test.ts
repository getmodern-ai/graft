import { describe, expect, it } from "vitest";

import {
  firstSentence,
  readyMadeKey,
  readyMadeWireName,
  SETUP_READY_MADE_MAX,
  setupReadyMade,
} from "./ready-made";
import {
  STARTER_VENDORS,
  type StarterVendor,
  starterTasks,
  starterVendorOf,
} from "./starter-vendors";

const entry = (name: string, readOnly = true, description = `${name}. More.`) => ({
  name,
  description,
  annotations: { readOnly },
});

describe("setupReadyMade", () => {
  const gmail = starterVendorOf("gmail");

  it("offers the curated tools the catalogue holds as read-only, the curated task's match first", () => {
    const offered = setupReadyMade(gmail, [
      entry("list-labels", true, "Lists Gmail labels and their ids. Each label's id feeds others."),
      entry("send-email", false),
      entry("search-messages", true, "Finds Gmail messages. Ids feed get-message."),
    ]);
    expect(offered).toEqual([
      {
        tool: "gmail__search-messages",
        goal: "Show me my latest inbox emails",
        description: "Finds Gmail messages.",
        replaces: ["Show me my five latest inbox conversations"],
      },
      {
        tool: "gmail__list-labels",
        goal: "List my Gmail labels",
        description: "Lists Gmail labels and their ids.",
        replaces: [],
      },
    ]);
  });

  it("drops a curated tool the catalogue lacks or holds as a write, and offers none for another integration", () => {
    expect(setupReadyMade(gmail, [entry("search-messages", false)])).toEqual([]);
    expect(setupReadyMade(gmail, [])).toEqual([]);
    expect(setupReadyMade(null, [entry("search-messages")])).toEqual([]);
  });

  it("offers at most a row of cards", () => {
    const stripe = starterVendorOf("stripe");
    const catalogue = (stripe?.readyMade ?? []).map((curated) => entry(curated.tool));
    expect(setupReadyMade(stripe, catalogue).length).toBeLessThanOrEqual(SETUP_READY_MADE_MAX);
  });

  it("curates at most a row for every starter, each tool once, in the person's words", () => {
    for (const starter of STARTER_VENDORS as readonly StarterVendor[]) {
      const names = starter.readyMade.map((curated) => curated.tool);
      expect(new Set(names).size, starter.id).toBe(names.length);
      expect(names.length, starter.id).toBeLessThanOrEqual(SETUP_READY_MADE_MAX);
      const tasks = starterTasks(starter).map((task) => task.goal);
      for (const curated of starter.readyMade) {
        expect(curated.goal, starter.id).not.toMatch(/__|\.$/);
        // A task it does in other words names one the step would otherwise offer to build.
        for (const task of curated.replaces ?? []) expect(tasks, starter.id).toContain(task);
      }
    }
  });
});

describe("the wire name", () => {
  it("reads back what it writes, and refuses what is not one", () => {
    expect(readyMadeKey(readyMadeWireName("google-drive", "list-recent-files"))).toEqual({
      vendor: "google-drive",
      name: "list-recent-files",
    });
    expect(readyMadeKey("gmail")).toBeNull();
    expect(readyMadeKey("__search")).toBeNull();
    expect(readyMadeKey("gmail__")).toBeNull();
  });
});

describe("firstSentence", () => {
  it("cuts at the first full stop before a space, and keeps a text without one", () => {
    expect(firstSentence(" Lists labels. Ids feed others. ")).toBe("Lists labels.");
    expect(firstSentence("Lists labels")).toBe("Lists labels");
  });
});
