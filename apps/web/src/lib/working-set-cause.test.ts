import { workingSetChangeCause } from "@graft/db/schema/working-set";
import { describe, expect, it } from "vitest";

import { WORKING_SET_CAUSE } from "./working-set-cause";

describe("the working-set history's cause sentences", () => {
  // The record's enum is the source; a cause added there without a sentence here would render as
  // nothing in the history, which is the one fact the history exists to show.
  it("has one for every cause the record can carry, in sentence case without a full stop", () => {
    expect(Object.keys(WORKING_SET_CAUSE).sort()).toEqual([...workingSetChangeCause].sort());
    for (const cause of workingSetChangeCause) {
      expect(WORKING_SET_CAUSE[cause]).toMatch(/^[A-Z][^.]*$/);
    }
  });

  /** ADR 0009 as amended 2026-09-18 (GRA-69): a revoke's demotion is the connection's doing, and the sentence says so. */
  it("says a revoke took the tool's connection", () => {
    expect(WORKING_SET_CAUSE.revoke).toBe("Its connection was revoked");
  });
});
