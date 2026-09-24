import { describe, expect, it } from "vitest";

import {
  type AskOrigin,
  connectedSettledSentence,
  connectedToastDescription,
  declinedToastDescription,
  scopeAllowedSettledSentence,
  scopeAllowedToastDescription,
} from "./ask-answered-copy";

/** Every sentence each origin can produce, for the rules that hold across all of them. */
function everySentence(origin: AskOrigin): string[] {
  return [
    connectedToastDescription({ origin, agentName: "Claude" }),
    connectedToastDescription({ origin, agentName: "Claude", approveBuild: true }),
    connectedToastDescription({ origin, agentName: "Claude", provider: "broker" }),
    connectedSettledSentence({ origin }),
    connectedSettledSentence({ origin, widens: true }),
    connectedSettledSentence({ origin, provider: "broker" }),
    scopeAllowedToastDescription({ origin }),
    scopeAllowedToastDescription({ origin, approveBuild: true }),
    scopeAllowedSettledSentence({ origin }),
    scopeAllowedSettledSentence({ origin, approveBuild: true }),
    declinedToastDescription(origin),
  ];
}

describe("an answered connection ask's copy (GRA-212)", () => {
  it("keeps the agent's form as it was: a call is waiting on the ask", () => {
    expect(connectedToastDescription({ origin: "agent", agentName: "Claude" })).toBe(
      "In Claude's scope; its waiting call answers connected. Other agents get it when you add it to theirs.",
    );
    expect(
      connectedToastDescription({
        origin: "agent",
        agentName: "Claude",
        approveBuild: true,
        provider: "broker",
      }),
    ).toBe(
      "In Claude's scope, allowed to build tools against it; its waiting call answers connected. The account's token stays with broker.",
    );
    expect(scopeAllowedToastDescription({ origin: "agent", approveBuild: true })).toBe(
      "Allowed to build tools against it; its waiting call answers connected. Nothing was entered and no new connection was made.",
    );
    expect(declinedToastDescription("agent")).toBe("The agent's waiting call is refused.");
  });

  it("says Setup's next step in Setup, where no call is waiting", () => {
    expect(
      connectedToastDescription({ origin: "setup", agentName: "Claude", approveBuild: true }),
    ).toBe("In Claude's scope, allowed to build tools against it. Setup moves on to the task.");
    expect(
      connectedToastDescription({ origin: "setup", agentName: "Claude", provider: "broker" }),
    ).toBe(
      "In Claude's scope, and the account's token stays with broker. Setup moves on to the task.",
    );
    expect(scopeAllowedToastDescription({ origin: "setup" })).toBe(
      "Nothing was entered and no new connection was made. Setup moves on to the task.",
    );
    expect(declinedToastDescription("setup")).toBe(
      "Nothing was connected. Setup goes back to the integrations.",
    );
    for (const sentence of everySentence("setup")) {
      expect(sentence).not.toContain("waiting call");
      expect(sentence).not.toContain("Other agents");
    }
  });

  it("says nothing with an em dash, in either origin", () => {
    for (const origin of ["agent", "setup"] as const) {
      for (const sentence of everySentence(origin)) expect(sentence).not.toContain("—");
    }
  });
});
