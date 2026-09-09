import { MockLanguageModelV4 } from "ai/test";

/**
 * Stand-ins for the provider's two models, for the adapter's own suite: an AI SDK mock whose answer
 * is a function of the last user message, so a script can be written against what the adapter
 * renders — "## Goal", "## Documentation pages", "## The check refused" — rather than against call
 * order. The mock records every call (`doGenerateCalls`), which is how a test reads what the model
 * was shown.
 */

/** The provider spec's call options, as the mock records them — derived so this file adds no dependency. */
export type LanguageModelV4CallOptions = MockLanguageModelV4["doGenerateCalls"][number];

/** The last user message's text, as the adapter rendered it. */
export function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i -= 1) {
    const message = options.prompt[i];
    if (message?.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

/** Every message's text, in order — for asserting what was and was not in the context. */
export function promptText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? String(part.text) : "")).join(""),
    )
    .join("\n");
}

export type MockUsage = { inputTokens: number; outputTokens: number };

export const MOCK_USAGE: MockUsage = { inputTokens: 10, outputTokens: 20 };

/** A model that answers `answer(lastUserText)` as text — an object is serialised, a string sent as is. */
export function mockModel(
  answer: (lastUser: string, options: LanguageModelV4CallOptions) => string | object,
  options: { modelId?: string; provider?: string; usage?: MockUsage } = {},
): MockLanguageModelV4 {
  const usage = options.usage ?? MOCK_USAGE;
  return new MockLanguageModelV4({
    modelId: options.modelId ?? "mock-model",
    provider: options.provider ?? "mock",
    doGenerate: async (call) => {
      const produced = answer(lastUserText(call), call);
      const text = typeof produced === "string" ? produced : JSON.stringify(produced);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: usage.inputTokens,
            noCache: usage.inputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: usage.outputTokens,
            text: usage.outputTokens,
            reasoning: undefined,
          },
        },
        warnings: [],
      };
    },
  });
}
