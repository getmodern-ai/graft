import { describe, expect, it } from "vitest";

import { mutationEvent, TRACKED_MUTATIONS } from "./analytics-events";

describe("mutationEvent", () => {
  it("reads a declared key as a dotted path into the tracked map", () => {
    expect(mutationEvent(["agent", "create"])).toBe("agent_created");
    expect(mutationEvent(["pending-action", "answer"])).toBe("approval_answered");
  });

  it("is null for no key, an unlisted key, and a key that is not a list of strings", () => {
    expect(mutationEvent(undefined)).toBeNull();
    expect(mutationEvent([])).toBeNull();
    expect(mutationEvent(["agent", "rename"])).toBeNull();
    expect(mutationEvent([["agent", "create"], { type: "mutation" }])).toBeNull();
  });

  it("spells every event noun_verbed in snake case", () => {
    for (const event of Object.values(TRACKED_MUTATIONS)) {
      expect(event).toMatch(/^[a-z]+(_[a-z]+)+$/);
    }
  });
});
