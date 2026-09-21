import { describe, expect, it } from "vitest";

import { NO_ANALYTICS } from "./analytics";

describe("the analytics seam", () => {
  it("has a no-op that is exactly the absence of the feature", async () => {
    expect(NO_ANALYTICS.name).toBe("off");
    expect(
      NO_ANALYTICS.capture({ distinctId: "person_1", event: "agent_created" }),
    ).toBeUndefined();
    // A person property rides the same call and is as much nothing under the no-op (GRA-157).
    expect(
      NO_ANALYTICS.capture({
        distinctId: "person_1",
        event: "person_signed_up",
        properties: { method: "email" },
        person: { email: "someone@example.com" },
      }),
    ).toBeUndefined();
    await expect(NO_ANALYTICS.shutdown()).resolves.toBeUndefined();
  });
});
