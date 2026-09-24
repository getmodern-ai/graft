import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { GOAL_PROPOSAL_MAX_LENGTH, usableGoals } from "./propose-goals";
import { createProviderModel } from "./provider";
import { createRoutedModel } from "./routed";
import { createScriptedModel, scriptedGoals } from "./scripted";
import type { ModelCallTrace, ModelTelemetry } from "./telemetry";
import { lastUserText, mockModel } from "./testing/mock-models";
import type { GoalProposalRequest, ModelAdapter } from "./types";

/**
 * Setup's goal suggestions (GRA-209) through the provider-backed adapter against the AI SDK's mock
 * model, the way `provider.test.ts` drives a job's triage: three goals on a good answer, none on a
 * refusal or a timeout, the curated goal in the prompt, the triage model and never the authoring
 * one. Then the scripted backing's fixed set and the router's per-person choice.
 */

const REQUEST: GoalProposalRequest = {
  personId: "person_a",
  traceId: "setup:person_a",
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.com/v1",
  docsUrl: "https://open-meteo.com/en/docs",
  curatedGoal: "Tell me the weather right now in a city I name",
};

function adapter(
  triage: MockLanguageModelV4,
  options: { telemetry?: ModelTelemetry; timeoutMs?: number } = {},
) {
  const authoring = mockModel(() => {
    throw new Error("the authoring model is never asked for goals");
  });
  const model = createProviderModel(
    { provider: "openai", apiKey: "sk-test" },
    {
      models: { authoring, triage },
      telemetry: options.telemetry,
      goalProposal: options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
    },
  );
  return { model, authoring };
}

/** What the triage model was shown on its first call. */
function firstPrompt(model: MockLanguageModelV4): string {
  const call = model.doGenerateCalls[0];
  if (!call) throw new Error("the triage model was not called");
  return lastUserText(call);
}

async function propose(model: ModelAdapter, request = REQUEST) {
  if (!model.proposeGoals) throw new Error("the adapter proposes goals");
  return model.proposeGoals(request);
}

describe("proposeGoals, provider-backed", () => {
  it("answers three goals on a good answer, from the triage model, with the curated goal in the prompt", async () => {
    const triage = mockModel(() => ({
      goals: [
        "Show the forecast for Melbourne tomorrow",
        "Tell me the weather right now in a city I name",
        "  List the hourly temperature in Paris today ",
        "Show today's sunrise and sunset in Tokyo",
        "Show the UV index in Sydney right now",
      ],
    }));
    const traces: ModelCallTrace[] = [];
    const telemetry: ModelTelemetry = {
      integrations: [],
      traced: async (trace, fn) => {
        traces.push(trace);
        return fn();
      },
    };
    const { model, authoring } = adapter(triage, { telemetry });

    const proposal = await propose(model);

    expect(proposal).toEqual({
      goals: [
        "Show the forecast for Melbourne tomorrow",
        "List the hourly temperature in Paris today",
        "Show today's sunrise and sunset in Tokyo",
      ],
      outcome: "proposed",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(authoring.doGenerateCalls).toHaveLength(0);
    expect(triage.doGenerateCalls).toHaveLength(1);
    const prompt = firstPrompt(triage);
    expect(prompt).toContain("Tell me the weather right now in a city I name");
    expect(prompt).toContain("Vendor: open-meteo (Open-Meteo)");
    expect(prompt).toContain("Primary host: https://api.open-meteo.com/v1");
    expect(prompt).toContain("Documentation: https://open-meteo.com/en/docs");
    expect(traces).toEqual([
      {
        role: "triage",
        jobId: "setup:person_a",
        personId: "person_a",
        attempt: 0,
        situation: "propose_goals",
        provider: "openai",
        modelId: "gpt-5.4-mini",
      },
    ]);
  });

  it("says so in the prompt when there is no curated goal or documentation, as for another vendor", async () => {
    const triage = mockModel(() => ({ goals: ["List my open tickets"] }));
    const { model } = adapter(triage);
    const proposal = await propose(model, { ...REQUEST, curatedGoal: null, docsUrl: null });
    expect(proposal.goals).toEqual(["List my open tickets"]);
    const prompt = firstPrompt(triage);
    expect(prompt).toContain("Documentation: (none given)");
    expect(prompt).toContain("Curated goal:\n(none)");
  });

  it("answers none on a refusal in prose, which is not the shape", async () => {
    const { model } = adapter(mockModel(() => "I can't help with suggesting goals for this API."));
    const proposal = await propose(model);
    expect(proposal.goals).toEqual([]);
    expect(proposal.outcome).toBe("unusable");
  });

  it("answers none when the model declines with an empty list, or every goal is unusable", async () => {
    const declined = await propose(adapter(mockModel(() => ({ goals: [] }))).model);
    expect(declined).toMatchObject({ goals: [], outcome: "declined" });
    const unusable = await propose(
      adapter(
        mockModel(() => ({
          goals: ["", "x".repeat(GOAL_PROPOSAL_MAX_LENGTH + 1), REQUEST.curatedGoal],
        })),
      ).model,
    );
    expect(unusable).toMatchObject({ goals: [], outcome: "unusable" });
  });

  it("answers none once the bound passes, whether or not the provider heeds the abort", async () => {
    const hung = new MockLanguageModelV4({
      modelId: "hung",
      doGenerate: () => new Promise(() => {}),
    });
    const proposal = await propose(adapter(hung, { timeoutMs: 20 }).model);
    expect(proposal).toEqual({
      goals: [],
      outcome: "timeout",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("answers none, with the message for the log, when the call fails", async () => {
    const failing = new MockLanguageModelV4({
      modelId: "failing",
      doGenerate: async () => {
        throw new Error("401 invalid api key");
      },
    });
    const proposal = await propose(adapter(failing).model);
    expect(proposal.goals).toEqual([]);
    expect(proposal.outcome).toBe("failed");
    expect(proposal.error).toContain("401 invalid api key");
  });
});

describe("usableGoals", () => {
  it("cleans, drops the curated goal whatever its case, drops repeats and keeps three", () => {
    expect(
      usableGoals(
        [
          '"Show my inbox"',
          "show my inbox",
          "TELL ME THE WEATHER RIGHT NOW IN A CITY I NAME",
          "List   my labels",
          "Count my drafts",
          "Show my starred emails",
        ],
        REQUEST.curatedGoal,
      ),
    ).toEqual(["Show my inbox", "List my labels", "Count my drafts"]);
  });
});

describe("proposeGoals, scripted", () => {
  it("answers the fixed set with the vendor's name and records what it was asked", async () => {
    const scripted = createScriptedModel([]);
    const proposal = await scripted.proposeGoals(REQUEST);
    expect(proposal.outcome).toBe("proposed");
    expect(proposal.goals).toEqual(scriptedGoals("Open-Meteo"));
    expect(proposal.goals).toHaveLength(3);
    expect(scripted.proposals).toEqual([REQUEST]);
  });
});

describe("proposeGoals, routed", () => {
  function proposer(name: string): ModelAdapter & { asked: string[] } {
    const asked: string[] = [];
    return {
      name,
      asked,
      open: () => {
        throw new Error("no job here");
      },
      proposeGoals: async (request) => {
        asked.push(request.personId);
        return {
          goals: [`${name} goal`],
          outcome: "proposed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
  }

  it("goes to the person's own adapter, else the fixed one, else answers none", async () => {
    const own = proposer("own");
    const fixed = proposer("fixed");
    const routed = createRoutedModel({
      fixed,
      resolve: async (personId) => (personId === "person_a" ? own : null),
    });
    expect((await propose(routed)).goals).toEqual(["own goal"]);
    expect((await propose(routed, { ...REQUEST, personId: "person_b" })).goals).toEqual([
      "fixed goal",
    ]);
    expect(own.asked).toEqual(["person_a"]);
    expect(fixed.asked).toEqual(["person_b"]);

    const none = createRoutedModel({ fixed: null, resolve: async () => null });
    expect(await propose(none)).toEqual({
      goals: [],
      outcome: "unavailable",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
