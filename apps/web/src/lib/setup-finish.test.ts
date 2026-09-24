import { describe, expect, it } from "vitest";

import {
  finishSections,
  finishVariant,
  promptToolOf,
  snippetShapeOf,
  tokenReplaceable,
  toolArrival,
} from "./setup-finish";

const GOAL = "Read the current weather for a city. Read only.";

describe("finishVariant", () => {
  it("shows the token for a static-token harness, the consent for an OAuth one, and the chat for an adopted agent", () => {
    expect(finishVariant("hermes")).toBe("token");
    expect(finishVariant("openclaw")).toBe("token");
    expect(finishVariant("other")).toBe("token");
    expect(finishVariant("claude")).toBe("oauth");
    expect(finishVariant("chatgpt")).toBe("oauth");
    expect(finishVariant("claude-code")).toBe("oauth");
    expect(finishVariant("codex")).toBe("oauth");
    expect(finishVariant(null)).toBe("adopted");
  });

  it("draws each static-token harness's configuration in its own shape", () => {
    expect(snippetShapeOf("hermes")).toBe("hermes");
    expect(snippetShapeOf("openclaw")).toBe("openclaw");
    expect(snippetShapeOf("other")).toBe("generic");
  });
});

describe("toolArrival and promptToolOf", () => {
  it("names the tool once it landed", () => {
    const context = {
      goal: GOAL,
      job: { status: "succeeded", failure: null },
      tool: { wireName: "open-meteo__current-weather" },
    };
    expect(toolArrival(context)).toEqual({
      kind: "landed",
      wireName: "open-meteo__current-weather",
    });
    expect(promptToolOf(context)).toEqual({ goal: GOAL, wireName: "open-meteo__current-weather" });
  });

  it("says the tool is arriving while the job the person continued past still runs", () => {
    for (const status of ["queued", "running", "succeeded"]) {
      const context = { goal: GOAL, job: { status, failure: null }, tool: null };
      expect(toolArrival(context)).toEqual({ kind: "arriving" });
      expect(promptToolOf(context)).toEqual({ goal: GOAL });
    }
  });

  it("carries the failure's sentence, and names no tool in the prompt, once the job failed", () => {
    const context = {
      goal: GOAL,
      job: { status: "failed", failure: "The model gave up." },
      tool: null,
    };
    expect(toolArrival(context)).toEqual({ kind: "failed", message: "The model gave up." });
    expect(promptToolOf(context)).toBeUndefined();
    expect(toolArrival({ goal: null, job: null, tool: null })).toEqual({ kind: "none" });
  });
});

describe("finishSections (GRA-215)", () => {
  const fresh = { issued: false, awaiting: true, replaceable: false };

  it("gives an OAuth harness the prompt, with the URL and the steps behind the disclosure", () => {
    expect(finishSections("oauth", fresh)).toEqual({
      prompt: true,
      token: null,
      byHand: "oauth",
      askInChat: false,
      primary: "finish",
      reissue: false,
    });
  });

  it("gives a token harness the token block and the prompt, issuing the token before the finish", () => {
    expect(finishSections("token", fresh)).toEqual({
      prompt: true,
      token: "to_issue",
      byHand: "token",
      askInChat: false,
      primary: "issue_token",
      reissue: false,
    });
    expect(
      finishSections("token", { issued: true, awaiting: false, replaceable: true }),
    ).toMatchObject({ token: "issued", primary: "finish", reissue: false });
    // An agent issued a token elsewhere keeps the one it has; Finish Setup is the action.
    expect(
      finishSections("token", { issued: false, awaiting: false, replaceable: false }),
    ).toMatchObject({ token: "saved", primary: "finish", reissue: false });
  });

  it("offers a new token where the one issued was lost and the route may still replace it", () => {
    // Greptile on #172: the page was reloaded after Issue the token and before the token was saved.
    expect(
      finishSections("token", { issued: false, awaiting: false, replaceable: true }),
    ).toMatchObject({ token: "saved", primary: "finish", reissue: true });
    const agent = { tokenPrefix: "grft_abc", connectedVia: null, revokedAt: null };
    expect(tokenReplaceable(agent)).toBe(true);
    expect(tokenReplaceable({ ...agent, tokenPrefix: null })).toBe(false);
    expect(tokenReplaceable({ ...agent, connectedVia: { clientId: "c", clientName: "C" } })).toBe(
      false,
    );
    expect(tokenReplaceable({ ...agent, revokedAt: "2026-09-25T00:00:00.000Z" })).toBe(false);
  });

  it("gives an adopted agent the one request to ask, and nothing else", () => {
    expect(finishSections("adopted", fresh)).toEqual({
      prompt: false,
      token: null,
      byHand: null,
      askInChat: true,
      primary: "finish",
      reissue: false,
    });
  });
});
