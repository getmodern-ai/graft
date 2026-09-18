import { describe, expect, it } from "vitest";

import { NO_ANALYTICS } from "./analytics";

describe("the analytics seam", () => {
  it("has a no-op that is exactly the absence of the feature", async () => {
    expect(NO_ANALYTICS.name).toBe("off");
    expect(
      NO_ANALYTICS.capture({ distinctId: "person_1", event: "agent_created" }),
    ).toBeUndefined();
    await expect(NO_ANALYTICS.shutdown()).resolves.toBeUndefined();
  });
});
