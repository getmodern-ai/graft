import { describe, expect, it } from "vitest";

import {
  accessChoiceSent,
  accessLegend,
  accessOptions,
  DEFAULT_ACCESS_CHOICE,
} from "./access-choice";

const BOTH = { approveBuild: true, allowVendor: true };

describe("accessChoiceSent (GRA-314)", () => {
  it("sends both grants for Full access and neither for Ask me first", () => {
    expect(accessChoiceSent("full", BOTH)).toEqual(BOTH);
    expect(accessChoiceSent("ask", BOTH)).toEqual({ approveBuild: false, allowVendor: false });
  });

  it("never sends a grant the card does not draw", () => {
    expect(accessChoiceSent("full", { approveBuild: false, allowVendor: true })).toEqual({
      approveBuild: false,
      allowVendor: true,
    });
  });

  it("starts on Full access", () => {
    expect(DEFAULT_ACCESS_CHOICE).toBe("full");
  });
});

describe("accessOptions", () => {
  it("names the agent and the integration, Full access first and recommended", () => {
    const [full, ask] = accessOptions("Hermes", "Unleashed");
    expect(full).toMatchObject({ value: "full", title: "Full access", recommended: true });
    expect(full?.description).toBe(
      "Hermes can build Unleashed tools and run them without asking. Tools that can delete still ask.",
    );
    expect(ask).toMatchObject({ value: "ask", title: "Ask me first", recommended: false });
    expect(accessLegend("Hermes")).toBe("What can Hermes do with it?");
  });

  it("never says the agent asks before it uses each tool: reads never ask", () => {
    for (const option of accessOptions("Hermes", "Unleashed")) {
      expect(option.description).not.toMatch(/use each tool|uses each tool/);
      expect(option.description).not.toContain("—");
    }
  });
});
