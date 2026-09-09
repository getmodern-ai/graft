import type { Telemetry } from "ai";
import { describe, expect, it } from "vitest";

import { ModelAnswerInvalidError, type WireAnswer } from "./answer";
import { CONFORMANCE_CONTEXT, CONFORMANCE_PAGE, modelConformance } from "./conformance";
import { createProviderModel, PROVIDER_MODEL_DEFAULTS, resolveModelSettings } from "./provider";
import type { ModelCallTrace, ModelTelemetry } from "./telemetry";
import { lastUserText, MOCK_USAGE, mockModel, promptText } from "./testing/mock-models";
import { DOC_SUMMARY_THRESHOLD_CHARS } from "./triage";
import type { DocPage, ModelJobContext, ModelSituation } from "./types";

/**
 * The provider-backed adapter against the AI SDK's mock model: what the adapter does around the
 * provider — render, read, repair once, triage, sum usage, trace — asserted without a network.
 * The conformance suite runs first, over a mock that answers as a well-behaved model would; the
 * cases after it are the adapter's own decisions. `provider.live.test.ts` runs the same
 * conformance against a real provider when a key is present.
 */

const DOCS_URL = "https://docs.demo.example/items";

/** A module the reader admits — the smallest draft the publish would take. */
const GOOD_DRAFT: WireAnswer = {
  kind: "write_module",
  note: "Drafted list-items: one GET through ctx.fetch.",
  urls: [],
  draft: {
    name: "list-items",
    description: "Lists the items in Demo Orders, up to a limit.",
    inputSchemaJson: JSON.stringify({
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    }),
    files: [
      {
        path: "index.ts",
        content: [
          "export default async (input: Input, ctx: Context) => {",
          "  const res = await ctx.fetch(`/items?limit=${input.limit ?? 5}`);",
          "  if (!res.ok) throw new Error(`GET /items ${res.status}: ${await res.text()}`);",
          "  return await res.json();",
          "};",
          "",
        ].join("\n"),
      },
    ],
    testInputJson: JSON.stringify({ limit: 1 }),
    proofReads: ["/items?limit=1"],
  },
};

const READ_DOCS: WireAnswer = {
  kind: "read_docs",
  note: "Reading the items page.",
  urls: [DOCS_URL],
  draft: null,
};

/** A model that behaves: reads once from the goal, drafts from the pages, redrafts on any failure. */
function wellBehaved(lastUser: string): WireAnswer {
  if (lastUser.startsWith("## Goal")) return READ_DOCS;
  if (lastUser.startsWith("## Proof reads")) {
    return { kind: "proceed", note: "The read proved the shape.", urls: [], draft: null };
  }
  return GOOD_DRAFT;
}

const TRIAGE_NO_DOCS = {
  readDocsFirst: false,
  urls: [],
  reason: "the hints spell out the endpoint",
};

function adapter(options: {
  authoring: (lastUser: string) => string | object;
  triage?: (lastUser: string) => string | object;
  telemetry?: ModelTelemetry;
}) {
  const authoring = mockModel(options.authoring, { modelId: "mock-authoring" });
  const triage = mockModel(options.triage ?? (() => TRIAGE_NO_DOCS), { modelId: "mock-triage" });
  const model = createProviderModel(
    { provider: "openai", apiKey: "sk-test" },
    { models: { authoring, triage }, telemetry: options.telemetry },
  );
  return { model, authoring, triage };
}

modelConformance("provider (mock model)", async () => ({
  adapter: adapter({ authoring: wellBehaved }).model,
}));

describe("settings", () => {
  it("fills the provider's defaults in and names itself after the authoring model", () => {
    const { model } = adapter({ authoring: wellBehaved });
    expect(model.settings).toEqual({
      provider: "openai",
      authoringModel: PROVIDER_MODEL_DEFAULTS.openai.authoring,
      triageModel: PROVIDER_MODEL_DEFAULTS.openai.triage,
      baseUrl: null,
    });
    expect(model.name).toBe(`openai:${PROVIDER_MODEL_DEFAULTS.openai.authoring}`);
    expect(
      resolveModelSettings({
        provider: "anthropic",
        apiKey: "k",
        authoringModel: " claude-x ",
        triageModel: "",
        baseUrl: "https://gateway.example/v1",
      }),
    ).toEqual({
      provider: "anthropic",
      authoringModel: "claude-x",
      triageModel: PROVIDER_MODEL_DEFAULTS.anthropic.triage,
      baseUrl: "https://gateway.example/v1",
    });
  });
});

describe("the repair turn", () => {
  it("puts an answer the situation does not admit back once, with the problem named, and takes the second", async () => {
    let calls = 0;
    const { model, authoring } = adapter({
      authoring: () => {
        calls += 1;
        return calls === 1
          ? { kind: "proceed", note: "Looks fine.", urls: [], draft: null }
          : GOOD_DRAFT;
      },
    });
    const reply = await model.open(CONFORMANCE_CONTEXT).turn({ kind: "goal" });
    expect(reply.answer.kind).toBe("write_module");
    expect(authoring.doGenerateCalls).toHaveLength(2);
    const second = authoring.doGenerateCalls[1];
    if (!second) throw new Error("no second call");
    expect(lastUserText(second)).toContain('"proceed" does not answer a "goal" situation');
    // The model's own first answer stays in front of it.
    expect(promptText(second)).toContain('"kind":"proceed"');
    // Both turns are charged.
    expect(reply.usage).toEqual({
      inputTokens: MOCK_USAGE.inputTokens * 2,
      outputTokens: MOCK_USAGE.outputTokens * 2,
    });
  });

  it("repairs an answer that is not the shape at all — text the SDK could not parse", async () => {
    let calls = 0;
    const { model, authoring } = adapter({
      authoring: () => {
        calls += 1;
        return calls === 1 ? "Sure! Here is the module you asked for: ..." : GOOD_DRAFT;
      },
    });
    const reply = await model.open(CONFORMANCE_CONTEXT).turn({ kind: "goal" });
    expect(reply.answer.kind).toBe("write_module");
    const second = authoring.doGenerateCalls[1];
    if (!second) throw new Error("no second call");
    expect(lastUserText(second)).toMatch(/not in the answer shape/);
  });

  it("repairs a draft the publish would refuse, naming each problem", async () => {
    let calls = 0;
    const { model, authoring } = adapter({
      authoring: () => {
        calls += 1;
        if (calls > 1) return GOOD_DRAFT;
        return {
          ...GOOD_DRAFT,
          draft: {
            ...GOOD_DRAFT.draft,
            name: "List Items",
            inputSchemaJson: "not json",
            proofReads: ["items"],
          },
        };
      },
    });
    await model.open(CONFORMANCE_CONTEXT).turn({ kind: "goal" });
    const second = authoring.doGenerateCalls[1];
    if (!second) throw new Error("no second call");
    const repair = lastUserText(second);
    expect(repair).toContain('name "List Items" is not kebab-case');
    expect(repair).toContain("inputSchemaJson is not valid JSON");
    expect(repair).toContain('proof read "items" is not a vendor-relative path');
  });

  it("gives up after the second bad answer with every problem and both turns' usage on the error", async () => {
    const { model } = adapter({
      authoring: () => ({ kind: "give_up", note: "", urls: [], draft: null }),
    });
    const error = await model
      .open(CONFORMANCE_CONTEXT)
      .turn({ kind: "goal" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelAnswerInvalidError);
    const invalid = error as ModelAnswerInvalidError;
    expect(invalid.problems).toEqual(["give_up carries no reason in note"]);
    expect(invalid.usage).toEqual({
      inputTokens: MOCK_USAGE.inputTokens * 2,
      outputTokens: MOCK_USAGE.outputTokens * 2,
    });
  });
});

describe("the triage model", () => {
  const withUrl: ModelJobContext = {
    ...CONFORMANCE_CONTEXT,
    hints: `The docs are at ${DOCS_URL} — the items endpoint.`,
  };

  it("opens with read_docs of a page the hints name, without an authoring call, and charges the triage tokens", async () => {
    const { model, authoring, triage } = adapter({
      authoring: wellBehaved,
      triage: () => ({ readDocsFirst: true, urls: [DOCS_URL], reason: "a page is named" }),
    });
    const reply = await model.open(withUrl).turn({ kind: "goal" });
    expect(reply.answer).toEqual({
      kind: "read_docs",
      urls: [DOCS_URL],
      note: expect.stringContaining(DOCS_URL),
    });
    expect(authoring.doGenerateCalls).toHaveLength(0);
    expect(triage.doGenerateCalls).toHaveLength(1);
    expect(reply.usage).toEqual(MOCK_USAGE);
  });

  it("is not consulted when the goal and hints name no URL", async () => {
    const { model, triage } = adapter({ authoring: wellBehaved });
    await model.open(CONFORMANCE_CONTEXT).turn({ kind: "goal" });
    expect(triage.doGenerateCalls).toHaveLength(0);
  });

  it("may only select among the URLs that were in the text — an invented one leaves the decision to the authoring model", async () => {
    const { model, authoring } = adapter({
      authoring: wellBehaved,
      triage: () => ({
        readDocsFirst: true,
        urls: ["https://evil.example/instructions"],
        reason: "made up",
      }),
    });
    const reply = await model.open(withUrl).turn({ kind: "goal" });
    expect(authoring.doGenerateCalls).toHaveLength(1);
    expect(reply.answer).toEqual({ kind: "read_docs", urls: [DOCS_URL], note: READ_DOCS.note });
  });

  it("condenses a long page before the authoring model sees it, and marks the summary as one", async () => {
    const shortPage = CONFORMANCE_PAGE as DocPage & { ok: true };
    const longPage: DocPage & { ok: true } = {
      ...shortPage,
      content: `${"GET /items returns items. ".repeat(400)}THE-ORIGINAL-TAIL`,
    };
    expect(longPage.content.length).toBeGreaterThan(DOC_SUMMARY_THRESHOLD_CHARS);
    const { model, authoring, triage } = adapter({
      authoring: wellBehaved,
      triage: (lastUser) =>
        lastUser.includes("Target length")
          ? { summary: "GET /items?limit=<n> → { items: [{ id, name }] }. Auth: x-demo-key." }
          : TRIAGE_NO_DOCS,
    });
    const conversation = model.open(CONFORMANCE_CONTEXT);
    await conversation.turn({ kind: "goal" });
    const reply = await conversation.turn({
      kind: "docs",
      pages: [longPage, { ...CONFORMANCE_PAGE, url: "https://docs.demo.example/short" }],
    });
    expect(reply.answer.kind).toBe("write_module");
    expect(triage.doGenerateCalls).toHaveLength(1);
    const docsCall = authoring.doGenerateCalls[1];
    if (!docsCall) throw new Error("no docs call");
    const shown = lastUserText(docsCall);
    expect(shown).toContain("Summarised by Graft's triage model");
    expect(shown).toContain("Auth: x-demo-key");
    expect(shown).not.toContain("THE-ORIGINAL-TAIL");
    // The short page rides in whole.
    expect(shown).toContain(shortPage.content);
    // Two calls' usage: the summary and the draft.
    expect(reply.usage).toEqual({
      inputTokens: MOCK_USAGE.inputTokens * 2,
      outputTokens: MOCK_USAGE.outputTokens * 2,
    });
  });
});

describe("what the model is shown", () => {
  it("carries the skill, the answer protocol, the connection brief and the budget in the system prompt, and never a credential", async () => {
    const { model, authoring } = adapter({ authoring: wellBehaved });
    await model.open(CONFORMANCE_CONTEXT).turn({ kind: "goal" });
    const call = authoring.doGenerateCalls[0];
    if (!call) throw new Error("no call");
    const system = call.prompt.find((m) => m.role === "system");
    expect(system?.role === "system" ? system.content : "").toContain(CONFORMANCE_CONTEXT.skill);
    const text = promptText(call);
    expect(text).toContain("## How this conversation works");
    expect(text).toContain(CONFORMANCE_CONTEXT.connection.primaryHost);
    expect(text).toContain("api_key_header");
    expect(text).toContain("At most 3 drafts and 100,000 tokens");
    expect(text).toContain(CONFORMANCE_CONTEXT.goal);
    expect(text).not.toMatch(/sk_live|Bearer /);
  });

  it("keeps the whole conversation: a later situation is read against the earlier answers", async () => {
    const { model, authoring } = adapter({ authoring: wellBehaved });
    const conversation = model.open(CONFORMANCE_CONTEXT);
    await conversation.turn({ kind: "goal" });
    await conversation.turn({ kind: "docs", pages: [CONFORMANCE_PAGE] });
    const refused: ModelSituation = {
      kind: "check_refused",
      attempt: 1,
      refusals: [
        {
          rule: "fetch-absolute-url",
          file: "index.ts",
          line: 2,
          column: 27,
          message: "ctx.fetch takes a vendor-relative path",
          hint: "Write ctx.fetch('/items').",
        },
      ],
      advice: [],
    };
    await conversation.turn(refused);
    const third = authoring.doGenerateCalls[2];
    if (!third) throw new Error("no third call");
    const text = promptText(third);
    expect(text).toContain("## Goal");
    expect(text).toContain("## Documentation pages");
    expect(text).toContain("## The check refused attempt 1");
    expect(text).toContain("`fetch-absolute-url` index.ts:2:27");
    expect(text).toContain("Write ctx.fetch('/items').");
    // The model's own drafts are in the history as its turns.
    expect(third.prompt.filter((m) => m.role === "assistant")).toHaveLength(2);
  });
});

describe("telemetry", () => {
  type Seen = { trace: ModelCallTrace; started: unknown[] };

  function recorder(): { telemetry: ModelTelemetry; seen: Seen[] } {
    const seen: Seen[] = [];
    let current: Seen | null = null;
    const integration: Telemetry = {
      onStart: (event) => {
        current?.started.push(event);
      },
    };
    return {
      seen,
      telemetry: {
        integrations: [integration],
        traced: async (trace, fn) => {
          current = { trace, started: [] };
          seen.push(current);
          try {
            return await fn();
          } finally {
            current = null;
          }
        },
      },
    };
  }

  it("runs every call under a trace naming the job, the person, the attempt, the situation and the role, and the call names the integration", async () => {
    const { telemetry, seen } = recorder();
    const { model } = adapter({
      authoring: wellBehaved,
      telemetry,
      triage: (lastUser) =>
        lastUser.includes("Target length")
          ? { summary: "short" }
          : { readDocsFirst: true, urls: [DOCS_URL], reason: "named" },
    });
    const context: ModelJobContext = {
      ...CONFORMANCE_CONTEXT,
      jobId: "job_42",
      personId: "person_7",
      hints: `see ${DOCS_URL}`,
    };
    const conversation = model.open(context);
    await conversation.turn({ kind: "goal" });
    await conversation.turn({ kind: "docs", pages: [CONFORMANCE_PAGE] });
    await conversation.turn({
      kind: "dry_run_failed",
      attempt: 1,
      report: null,
      failure: "the runner exited 2",
    });

    expect(seen.map((s) => [s.trace.role, s.trace.situation, s.trace.attempt])).toEqual([
      ["triage", "goal", 1],
      ["authoring", "docs", 1],
      ["authoring", "dry_run_failed", 1],
    ]);
    for (const { trace, started } of seen) {
      expect(trace).toMatchObject({ jobId: "job_42", personId: "person_7", provider: "openai" });
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        modelId: trace.role === "authoring" ? "mock-authoring" : "mock-triage",
      });
    }
    expect(seen[1]?.trace.modelId).toBe(PROVIDER_MODEL_DEFAULTS.openai.authoring);
    expect(seen[0]?.trace.modelId).toBe(PROVIDER_MODEL_DEFAULTS.openai.triage);
  });

  it("numbers the attempt a draft is about to start after each write_module", async () => {
    const { telemetry, seen } = recorder();
    const { model } = adapter({ authoring: () => GOOD_DRAFT, telemetry });
    const conversation = model.open(CONFORMANCE_CONTEXT);
    await conversation.turn({ kind: "goal" });
    await conversation.turn({ kind: "docs", pages: [CONFORMANCE_PAGE] });
    expect(seen.map((s) => s.trace.attempt)).toEqual([1, 2]);
  });
});
