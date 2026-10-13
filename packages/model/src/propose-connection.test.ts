import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { CONNECTION_PROPOSAL_INPUT_MAX_CHARS, renderProposalPages } from "./propose-connection";
import { createProviderModel } from "./provider";
import { createRoutedModel } from "./routed";
import {
  createScriptedModel,
  parseScript,
  readScriptConnectionProposal,
  scriptedConnectionProposal,
} from "./scripted";
import type { ModelCallTrace, ModelTelemetry } from "./telemetry";
import { lastUserText, mockModel } from "./testing/mock-models";
import type { ConnectionProposalRequest, ModelAdapter } from "./types";

/**
 * A connection proposal from an API's docs (GRA-299) through the provider-backed adapter against
 * the AI SDK's mock model, as `propose-goals.test.ts` drives the goal chips: the triage model and
 * never the authoring one, the pages and the schemes in the prompt, the trace and nothing secret
 * in it, none on a decline, a timeout or a failure. Then the scripted backing and the router.
 */

const API_KEY = "sk-live-never-in-a-trace";

const REQUEST: ConnectionProposalRequest = {
  personId: "person_a",
  traceId: "connect:person_a",
  name: "Acme Unleashed",
  docsUrl: "https://apidocs.unleashed.example/authentication",
  pages: [
    {
      url: "https://apidocs.unleashed.example/authentication",
      title: "Authentication",
      content:
        "Send every request to https://api.unleashed.example with your id in the api-auth-id header.",
      truncated: false,
    },
  ],
  schemes: [
    {
      scheme: "api_key_header",
      summary: "A key sent in a request header.",
      required: ["headerName"],
      optional: ["prefix"],
    },
    { scheme: "bearer", summary: "A token in Authorization: Bearer.", required: [], optional: [] },
  ],
};

const FOUND = {
  found: true,
  reason: "",
  vendor: "unleashed",
  primaryHost: "https://api.unleashed.example",
  hosts: [],
  scheme: "api_key_header",
  parameters: [
    { name: "headerName", value: "api-auth-id" },
    { name: "prefix", value: "" },
  ],
};

function adapter(
  triage: MockLanguageModelV4,
  options: { telemetry?: ModelTelemetry; timeoutMs?: number } = {},
) {
  const authoring = mockModel(() => {
    throw new Error("the authoring model is never asked for a connection");
  });
  const model = createProviderModel(
    { provider: "anthropic", apiKey: API_KEY },
    {
      models: { authoring, triage },
      telemetry: options.telemetry,
      connectionProposal: options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
    },
  );
  return { model, authoring };
}

async function propose(model: ModelAdapter, request = REQUEST) {
  if (!model.proposeConnection) throw new Error("the adapter proposes connections");
  return model.proposeConnection(request);
}

describe("proposeConnection, provider-backed", () => {
  it("answers the proposal from the triage model, with the pages and the schemes in the prompt", async () => {
    const triage = mockModel(() => FOUND);
    const traces: ModelCallTrace[] = [];
    const telemetry: ModelTelemetry = {
      integrations: [],
      traced: async (trace, fn) => {
        traces.push(trace);
        return fn();
      },
    };
    const { model, authoring } = adapter(triage, { telemetry });

    expect(await propose(model)).toEqual({
      proposal: {
        vendor: "unleashed",
        primaryHost: "https://api.unleashed.example",
        hosts: [],
        scheme: "api_key_header",
        // The empty prefix is a parameter the pages did not give, left out.
        schemeConfig: { headerName: "api-auth-id" },
      },
      outcome: "proposed",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(authoring.doGenerateCalls).toHaveLength(0);
    const call = triage.doGenerateCalls[0];
    if (!call) throw new Error("the triage model was called");
    const prompt = lastUserText(call);
    expect(prompt).toContain("Integration, as the person named it: Acme Unleashed");
    expect(prompt).toContain(
      "Documentation link: https://apidocs.unleashed.example/authentication",
    );
    expect(prompt).toContain(
      "- api_key_header: A key sent in a request header. Parameters: headerName, optional prefix.",
    );
    expect(prompt).toContain("api-auth-id header");
    expect(traces).toEqual([
      {
        role: "triage",
        jobId: "connect:person_a",
        personId: "person_a",
        attempt: 0,
        situation: "propose_connection",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    ]);
    // Nothing secret reaches the trace or the call: the provider key is the client's, never a
    // field of either.
    expect(JSON.stringify(traces)).not.toContain(API_KEY);
    expect(JSON.stringify(call)).not.toContain(API_KEY);
  });

  it("answers declined, with the model's reason, when the pages do not say", async () => {
    const answer = await propose(
      adapter(
        mockModel(() => ({
          ...FOUND,
          found: false,
          reason: "The page names no host.",
          primaryHost: "",
          scheme: "",
          parameters: [],
        })),
      ).model,
    );
    expect(answer).toMatchObject({
      proposal: null,
      outcome: "declined",
      reason: "The page names no host.",
    });
  });

  it("answers unusable on a refusal in prose, or a found answer with no address", async () => {
    expect(await propose(adapter(mockModel(() => "I cannot read that.")).model)).toMatchObject({
      proposal: null,
      outcome: "unusable",
    });
    expect(
      await propose(adapter(mockModel(() => ({ ...FOUND, primaryHost: " " }))).model),
    ).toMatchObject({ proposal: null, outcome: "unusable" });
  });

  it("answers timeout once the bound passes, whether or not the provider heeds the abort", async () => {
    const hung = new MockLanguageModelV4({
      modelId: "hung",
      doGenerate: () => new Promise(() => {}),
    });
    expect(await propose(adapter(hung, { timeoutMs: 20 }).model)).toEqual({
      proposal: null,
      outcome: "timeout",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("answers failed, with the message for the log, when the call fails", async () => {
    const failing = new MockLanguageModelV4({
      modelId: "failing",
      doGenerate: async () => {
        throw new Error("529 overloaded");
      },
    });
    const answer = await propose(adapter(failing).model);
    expect(answer.outcome).toBe("failed");
    expect(answer.error).toContain("529 overloaded");
  });
});

describe("renderProposalPages", () => {
  it("clips the pages together to the input bound, in order", () => {
    const long = "x".repeat(CONNECTION_PROPOSAL_INPUT_MAX_CHARS);
    const rendered = renderProposalPages({
      ...REQUEST,
      pages: [
        { url: "https://a.example", title: null, content: long, truncated: true },
        { url: "https://b.example", title: null, content: "never shown", truncated: false },
      ],
    });
    expect(rendered).toContain("### Page https://a.example, not the whole page");
    expect(rendered).not.toContain("https://b.example");
  });
});

describe("proposeConnection, scripted", () => {
  it("guesses the API's host from the documentation's, signing with a bearer token", async () => {
    const scripted = createScriptedModel([]);
    const answer = await scripted.proposeConnection(REQUEST);
    expect(answer).toMatchObject({
      outcome: "proposed",
      proposal: scriptedConnectionProposal(REQUEST.docsUrl),
    });
    expect(scriptedConnectionProposal("https://docs.acme.example/api")).toEqual({
      vendor: "acme",
      primaryHost: "https://api.acme.example",
      hosts: [],
      scheme: "bearer",
      schemeConfig: {},
    });
    expect(scripted.connectionProposals).toEqual([REQUEST]);
  });

  it("answers the script's proposal, or declines on null", async () => {
    const file = {
      steps: [],
      connectionProposal: {
        vendor: "unleashed",
        primaryHost: "https://api.unleashed.example",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
      },
    };
    expect(parseScript(file)).toEqual([]);
    const proposal = readScriptConnectionProposal(file);
    expect(proposal).toEqual({ ...file.connectionProposal, hosts: [] });
    const scripted = createScriptedModel([], { connectionProposal: proposal });
    expect((await scripted.proposeConnection(REQUEST)).proposal).toEqual(proposal);

    const declining = createScriptedModel([], {
      connectionProposal: readScriptConnectionProposal({ steps: [], connectionProposal: null }),
    });
    expect(await declining.proposeConnection(REQUEST)).toMatchObject({
      proposal: null,
      outcome: "declined",
    });
    expect(readScriptConnectionProposal([])).toBeUndefined();
    expect(() => readScriptConnectionProposal({ connectionProposal: { vendor: 1 } })).toThrow(
      /needs "vendor", "primaryHost" and "scheme"/,
    );
  });
});

describe("proposeConnection, routed", () => {
  it("asks the person's own model when they have one, the fixed model otherwise, and none without either", async () => {
    const own = createScriptedModel([], { name: "own", connectionProposal: null });
    const fixed = createScriptedModel([], { name: "fixed" });
    const routed = createRoutedModel({
      fixed,
      resolve: async (personId) => (personId === "person_a" ? own : null),
    });
    await propose(routed);
    await propose(routed, { ...REQUEST, personId: "person_b" });
    expect(own.connectionProposals.map((r) => r.personId)).toEqual(["person_a"]);
    expect(fixed.connectionProposals.map((r) => r.personId)).toEqual(["person_b"]);

    const none = createRoutedModel({ fixed: null, resolve: async () => null });
    expect(await propose(none)).toEqual({
      proposal: null,
      outcome: "unavailable",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
