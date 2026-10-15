import { describe, expect, it } from "vitest";

import { createFakeLinkProvider } from "./fake-link-provider";

/**
 * The fake's one rule a suite leans on for which account a link claims: the oldest unclaimed, in
 * the order the test connected them, whatever the clock read (GRA-337). A sort on `createdAt` made
 * the answer depend on whether two accounts fell in one millisecond.
 */

const complete = (fake: ReturnType<typeof createFakeLinkProvider>, takenRefs: string[] = []) => {
  if (fake.connect.kind !== "link") throw new Error("the fake is a link provider");
  return fake.connect.complete({
    personId: "person_1",
    vendor: "gmail",
    hosts: ["gmail.googleapis.com"],
    takenRefs,
  });
};

describe("the fake link provider's complete", () => {
  it.each([
    ["in one millisecond", [0, 0]],
    ["a millisecond apart", [0, 1]],
    ["with the clock stepping back", [5, 0]],
  ])("answers the oldest unclaimed account %s", async (_label, ticks) => {
    const times = [...ticks];
    const fake = createFakeLinkProvider({ now: () => new Date(1_000_000 + (times.shift() ?? 0)) });
    fake.connectAccount({ personId: "person_1", target: "gmail", id: "acct_1" });
    fake.connectAccount({ personId: "person_1", target: "gmail", id: "acct_2" });

    expect(await complete(fake)).toMatchObject({ ok: true, ref: "acct_1" });
    expect(await complete(fake, ["acct_1"])).toMatchObject({ ok: true, ref: "acct_2" });
    expect(await complete(fake, ["acct_1", "acct_2"])).toMatchObject({ ok: false });
  });
});
