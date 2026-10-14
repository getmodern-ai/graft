import { describe, expect, it } from "vitest";

import {
  agentSignInLine,
  agentSignInOf,
  toolsKeptReadyLine,
  unusedToolsLine,
} from "./agent-advanced";

describe("toolsKeptReadyLine", () => {
  it("says the cap, and how many the agent holds once the working set is read", () => {
    const agent = { name: "Claude", workingSetCap: 20 };
    expect(toolsKeptReadyLine(agent, 4)).toBe("Up to 20 at once. Claude currently has 4.");
    expect(toolsKeptReadyLine(agent, null)).toBe("Up to 20 at once.");
  });
});

describe("unusedToolsLine", () => {
  it("says the idle window in days", () => {
    expect(unusedToolsLine({ idleWindowDays: 21 })).toBe(
      "Put away after 21 days without use. They come back when needed.",
    );
    expect(unusedToolsLine({ idleWindowDays: 1 })).toContain("after 1 day without");
  });
});

describe("agentSignInOf and agentSignInLine", () => {
  const client = { clientId: "c", clientName: "Claude" };

  it("says an OAuth agent signs in through its client (GRA-287 item 5)", () => {
    const signIn = agentSignInOf({ connectedVia: client, tokenPrefix: null });
    expect(signIn).toEqual({ kind: "oauth", clientName: "Claude", tokenPrefix: null });
    expect(agentSignInLine(signIn)).toBe("Signs in through Claude with OAuth.");
  });

  it("names a static token by its prefix alone", () => {
    const signIn = agentSignInOf({ connectedVia: null, tokenPrefix: "grft_ab12" });
    expect(signIn).toEqual({ kind: "token", tokenPrefix: "grft_ab12" });
    expect(agentSignInLine(signIn)).toBe("Signs in with the token grft_ab12…");
  });

  it("names both when a client connected an agent that also holds a token", () => {
    expect(agentSignInLine(agentSignInOf({ connectedVia: client, tokenPrefix: "grft_ab12" }))).toBe(
      "Signs in through Claude with OAuth, and with the token grft_ab12…",
    );
  });

  it("says an agent awaiting its first sign-in is not signed in", () => {
    const signIn = agentSignInOf({ connectedVia: null, tokenPrefix: null });
    expect(signIn).toEqual({ kind: "none" });
    expect(agentSignInLine(signIn)).toBe("Not signed in yet. Connect an agent to sign it in.");
  });
});
