import { setupUrl } from "@graft/core/setup/setup.rules";
import { describe, expect, it } from "vitest";

import {
  afterSetupFinish,
  agentToAdopt,
  readSetupSearch,
  SETUP_CLOSE_MS,
  SETUP_FROM_CARD,
  setupFinishedToast,
} from "./setup-page";

/** The Setup page opened from `find_tool`'s offer or the ask card (GRA-210). */
describe("readSetupSearch", () => {
  it("reads the agent and from=card off the URL find_tool builds and the card opens", () => {
    const url = new URL(`${setupUrl("http://console.graft.test", "agent_1")}&from=card`);
    expect(readSetupSearch(Object.fromEntries(url.searchParams))).toEqual({
      agent: "agent_1",
      from: "card",
    });
  });

  it("reads nothing it does not recognise", () => {
    expect(readSetupSearch({})).toEqual({});
    expect(readSetupSearch({ agent: "", from: "console" })).toEqual({});
    expect(readSetupSearch({ agent: ["a"], from: ["card"] })).toEqual({});
  });
});

describe("agentToAdopt", () => {
  const one = { id: "agent_1" };
  const two = { id: "agent_2" };

  it("adopts the agent the URL names among several", () => {
    expect(agentToAdopt([one, two], "agent_2")).toBe(two);
  });

  it("adopts the only agent, whatever the URL names", () => {
    expect(agentToAdopt([one])).toBe(one);
    expect(agentToAdopt([one], "agent_gone")).toBe(one);
  });

  it("adopts none among several without a name it knows, or with no agent at all", () => {
    expect(agentToAdopt([one, two])).toBeNull();
    expect(agentToAdopt([one, two], "agent_gone")).toBeNull();
    expect(agentToAdopt([], "agent_1")).toBeNull();
  });
});

describe("afterSetupFinish", () => {
  const agent = { id: "agent_1" };

  it("closes a page the card opened once Setup is finished", () => {
    expect(afterSetupFinish({ from: "card" }, { token: null, agent })).toEqual({ kind: "close" });
    expect(afterSetupFinish({ agent: "agent_1", from: "card" }, { token: null, agent })).toEqual({
      kind: "close",
    });
  });

  it("stays when the finish issued a token, which is shown once", () => {
    expect(afterSetupFinish({ from: "card" }, { token: "grft_abc", agent })).toEqual({
      kind: "stay",
    });
    expect(afterSetupFinish({}, { token: "grft_abc", agent })).toEqual({ kind: "stay" });
  });

  it("leaves a visit the card did not open for the agent's page, or the table without one", () => {
    expect(afterSetupFinish({}, { token: null, agent })).toEqual({
      kind: "leave",
      to: "/agents/$agentId",
      agentId: "agent_1",
    });
    expect(afterSetupFinish({ agent: "agent_1" }, { token: null, agent: null })).toEqual({
      kind: "leave",
      to: "/agents",
    });
  });

  it("says in the toast where the tool stands", () => {
    expect(
      setupFinishedToast("Claude", { kind: "landed", wireName: "open-meteo__current-weather" }),
    ).toEqual({
      title: "Setup is complete",
      description: "open-meteo__current-weather is ready in Claude's tools.",
    });
    expect(setupFinishedToast("Claude", { kind: "arriving" }).description).toBe(
      "The tool joins Claude's tools when its job passes.",
    );
    expect(setupFinishedToast("Claude", { kind: "none" }).description).not.toContain("—");
  });

  it("waits the card popup's delay and says to ask again in the chat", () => {
    expect(SETUP_CLOSE_MS).toBeGreaterThan(0);
    expect(SETUP_FROM_CARD.message).toContain("ask again in the chat");
    expect(SETUP_FROM_CARD.doneMessage).toContain("close this window");
    for (const sentence of Object.values(SETUP_FROM_CARD)) {
      expect(sentence).not.toContain("—");
    }
  });
});
