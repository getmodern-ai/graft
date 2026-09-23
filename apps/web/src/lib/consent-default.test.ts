import { describe, expect, it } from "vitest";

import { consentDefaultAgent, NEW_AGENT } from "./consent-default";

const agent = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  revokedAt: null,
  tokenPrefix: null,
  connectedVia: null,
  ...overrides,
});

describe("consentDefaultAgent", () => {
  it("pre-selects the one agent awaiting its harness", () => {
    expect(
      consentDefaultAgent([
        agent("laptop", { tokenPrefix: "grft_abc" }),
        agent("setup"),
        agent("chat", { connectedVia: { clientId: "c", clientName: "ChatGPT" } }),
        agent("gone", { revokedAt: "2026-09-23T00:00:00Z" }),
      ]),
    ).toBe("setup");
  });

  it("falls back to a new agent with none awaiting, or several", () => {
    expect(consentDefaultAgent([])).toBe(NEW_AGENT);
    expect(consentDefaultAgent([agent("laptop", { tokenPrefix: "grft_abc" })])).toBe(NEW_AGENT);
    expect(consentDefaultAgent([agent("one"), agent("two")])).toBe(NEW_AGENT);
  });
});
