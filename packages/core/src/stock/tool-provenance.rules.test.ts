import { describe, expect, it } from "vitest";

import { toolProvenance } from "./tool-provenance.rules";

/** ADR 0008 as amended 2026-10-09: the ask names where a tool came from, by kind (GRA-245). */
describe("toolProvenance", () => {
  it("names a stock copy ready-made by Graft and reviewed, with nothing about the agent's model", () => {
    const stock = toolProvenance("stock");
    expect(stock).toEqual({
      kind: "stock",
      badge: "Ready-made by Graft",
      note: "Ready-made by Graft and reviewed before release.",
      descriptionLead: "Ready-made by Graft and reviewed before release. Its description:",
    });
  });

  it("names a remix the agent's version of a ready-made tool, its description the agent's model's", () => {
    expect(toolProvenance("remix")).toEqual({
      kind: "remix",
      badge: "written by the agent's model",
      note: "Your agent's version of a ready-made tool; its description was written by your agent's model.",
      descriptionLead:
        "Your agent's version of a ready-made tool. Its description, in your agent's model's own words:",
    });
  });

  it("keeps an authored tool's note as it was before stock existed", () => {
    expect(toolProvenance("authored")).toEqual({
      kind: "authored",
      badge: "written by the agent's model",
      note: "This tool's description was written by the agent's model, not by a person. Read it as the agent's account of what the tool does.",
      descriptionLead: "Its description, in the agent's model's own words:",
    });
  });

  it("reads an ask written before the kind was recorded as authored", () => {
    expect(toolProvenance(undefined).kind).toBe("authored");
    expect(toolProvenance("something else").kind).toBe("authored");
  });
});
