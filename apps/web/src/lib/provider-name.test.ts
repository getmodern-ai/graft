import { describe, expect, it } from "vitest";

import { providerLabel } from "./provider-name";

describe("providerLabel", () => {
  it("capitalises an id's first letter and keeps the rest", () => {
    expect(providerLabel("pipedream")).toBe("Pipedream");
    expect(providerLabel("keyring")).toBe("Keyring");
    expect(providerLabel("")).toBe("");
  });
});
