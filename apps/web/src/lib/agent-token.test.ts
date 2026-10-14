import { describe, expect, it } from "vitest";

import { tokenRotatable } from "./agent-token";

describe("tokenRotatable", () => {
  const active = { revokedAt: null, tokenPrefix: "grft_abc", connectedVia: null };

  it("offers rotation to an active agent reached by a static token alone", () => {
    expect(tokenRotatable(active)).toBe(true);
  });

  it.each([
    ["revoked", { revokedAt: "2026-10-14T00:00:00.000Z" }],
    ["awaiting its first token", { tokenPrefix: null }],
    [
      "connected by a client",
      { tokenPrefix: null, connectedVia: { clientId: "c", clientName: "Claude" } },
    ],
    // The server refuses an agent a client connected even when it kept a static token from before.
    [
      "holding a token and connected by a client",
      { connectedVia: { clientId: "c", clientName: "Claude" } },
    ],
  ])("offers none to an agent %s", (_case, patch) => {
    expect(tokenRotatable({ ...active, ...patch })).toBe(false);
  });
});
