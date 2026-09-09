import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  Output,
} from "ai";

import {
  ModelAnswerInvalidError,
  readWireAnswer,
  WIRE_ANSWER_SCHEMA,
  type WireAnswer,
  wireOf,
} from "./answer";
import { type RenderedPage, renderRepair, renderSituation, systemPrompt } from "./prompt";
import { type ModelCallTrace, type ModelTelemetry, NO_TELEMETRY } from "./telemetry";
import {
  addUsage,
  DOC_SUMMARY_THRESHOLD_CHARS,
  summariseDocPage,
  type TriageCall,
  telemetryOptions,
  traceContext,
  triageGoal,
  usageOf,
  ZERO_USAGE,
} from "./triage";
import type {
  ModelAdapter,
  ModelAnswer,
  ModelConversation,
  ModelJobContext,
  ModelSituation,
  ModelUsage,
} from "./types";

/**
 * The provider-backed model: the adapter seam (`./types.ts`) over a real provider through the AI
 * SDK — ADR 0004 (Graft holds the pen), ADR 0014 (one strong coding model authors, one cheap model
 * triages). It passes the same conformance suite the scripted backing does (`./conformance.ts`),
 * which is what makes the two interchangeable behind `acquire`.
 *
 * Two models, two jobs. The **authoring** model takes every situation that ends in code — the goal,
 * the pages, a refused check, the proof reads, a failed dry run — and answers in the wire shape
 * (`./answer.ts`) through the SDK's structured output. The **triage** model takes the cheap
 * decisions and never writes code (`./triage.ts`): whether the job opens with a round of
 * documentation, and condensing a long page before it enters the authoring context. Both models'
 * tokens are reported on every reply, so the job holds one ceiling over both.
 *
 * An answer the reader cannot use — a kind the situation does not admit, a draft the publish would
 * refuse, text that is not the shape at all — is put back to the authoring model once, with the
 * problems named, and the second answer is the last: after it the turn throws
 * `ModelAnswerInvalidError`, which the job records as `model_failed`. One repair turn rather than a
 * loop because the second failure is evidence about the model, not the prompt, and a job that
 * repairs indefinitely spends its ceiling saying so.
 *
 * The conversation keeps its own message history, one situation and one answer per turn, so a
 * later situation is read against everything the model already saw. Nothing here holds a
 * credential or a way to call a vendor: a proof read's answer arrives as text the job produced.
 */

export const MODEL_PROVIDERS = ["anthropic", "openai"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

/**
 * The model ids used when a deployment names none (`GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE`).
 * Anthropic: the current strongest coding model and the current cheapest. OpenAI: `gpt-5.6-sol`
 * is the model Cando runs in production for the same authoring work (its `BL_MODEL`), and
 * `gpt-5.4-mini` the cheapest of that line with the comprehension a page summary needs. Ids are
 * checked at the first call, not at boot — a provider's catalogue is not something the environment
 * schema can know — so a wrong id is a failed job saying so, never a silent fallback.
 */
export const PROVIDER_MODEL_DEFAULTS: Record<
  ModelProviderName,
  { authoring: string; triage: string }
> = {
  anthropic: { authoring: "claude-fable-5-1", triage: "claude-haiku-4-5-20251001" },
  openai: { authoring: "gpt-5.6-sol", triage: "gpt-5.4-mini" },
};

/** What a deployment — or a person's own key (ADR 0014) — configures. */
export type ProviderModelConfig = {
  provider: ModelProviderName;
  apiKey: string;
  /** Null or absent means the provider's default above. */
  authoringModel?: string | null;
  triageModel?: string | null;
  /**
   * Another endpoint speaking the provider's API — an OpenAI-compatible gateway, a proxy. For
   * OpenAI this also selects the Chat Completions surface over Responses, which is the contract an
   * "OpenAI-compatible" endpoint implements (the SDK's own guidance for a custom `baseURL`).
   */
  baseUrl?: string | null;
};

/** The configuration with its defaults filled in — what the adapter reports and the trace names. */
export type ProviderModelSettings = {
  provider: ModelProviderName;
  authoringModel: string;
  triageModel: string;
  baseUrl: string | null;
};

export type ResolvedModels = { authoring: LanguageModel; triage: LanguageModel };

export type ProviderModelDeps = {
  /** The observability binding (`./langfuse.ts`); `NO_TELEMETRY` when the deployment has none. */
  telemetry?: ModelTelemetry | null;
  /** A test's stand-ins for the provider's two models; the settings still name them in the trace. */
  models?: ResolvedModels;
};

export type ProviderModel = ModelAdapter & { readonly settings: ProviderModelSettings };

/** How much the authoring model may write in one answer: a module with its files, as JSON, and — on a reasoning model — the thinking before it. */
export const AUTHORING_MAX_OUTPUT_TOKENS = 32_000;

export function resolveModelSettings(config: ProviderModelConfig): ProviderModelSettings {
  const defaults = PROVIDER_MODEL_DEFAULTS[config.provider];
  return {
    provider: config.provider,
    authoringModel: config.authoringModel?.trim() || defaults.authoring,
    triageModel: config.triageModel?.trim() || defaults.triage,
    baseUrl: config.baseUrl?.trim() || null,
  };
}

/** The provider's two models, from its package. The key goes here and nowhere else in this file. */
export function providerModels(settings: ProviderModelSettings, apiKey: string): ResolvedModels {
  const baseURL = settings.baseUrl ? { baseURL: settings.baseUrl } : {};
  if (settings.provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey, ...baseURL });
    return {
      authoring: anthropic(settings.authoringModel),
      triage: anthropic(settings.triageModel),
    };
  }
  const openai = createOpenAI({ apiKey, ...baseURL });
  // Responses against api.openai.com; Chat Completions behind a gateway — see `baseUrl` above.
  const model = (id: string) => (settings.baseUrl ? openai.chat(id) : openai.responses(id));
  return { authoring: model(settings.authoringModel), triage: model(settings.triageModel) };
}

export function createProviderModel(
  config: ProviderModelConfig,
  deps: ProviderModelDeps = {},
): ProviderModel {
  const settings = resolveModelSettings(config);
  const bound: Bound = {
    settings,
    telemetry: deps.telemetry ?? NO_TELEMETRY,
    models: deps.models ?? providerModels(settings, config.apiKey),
  };
  return {
    name: `${settings.provider}:${settings.authoringModel}`,
    settings,
    open: (context) => openConversation(context, bound),
  };
}

type Bound = { settings: ProviderModelSettings; telemetry: ModelTelemetry; models: ResolvedModels };

/** One authoring call's answer: the wire object when the SDK could parse one, the text either way. */
type Asked = { wire: WireAnswer | null; text: string; problems: string[]; usage: ModelUsage };

function causeMessage(error: NoObjectGeneratedError): string {
  const cause = error.cause;
  if (cause instanceof Error) return cause.message;
  return error.message;
}

function openConversation(context: ModelJobContext, bound: Bound): ModelConversation {
  const { settings, telemetry, models } = bound;
  const system = systemPrompt(context);
  const history: ModelMessage[] = [];
  /** `write_module` answers so far — the attempt a situation without a number is about to start. */
  let drafts = 0;

  const traceFor = (situation: ModelSituation): Omit<ModelCallTrace, "role" | "modelId"> => ({
    jobId: context.jobId,
    personId: context.personId,
    attempt: "attempt" in situation ? situation.attempt : drafts + 1,
    situation: situation.kind,
    provider: settings.provider,
  });

  const record = (answer: ModelAnswer): void => {
    if (answer.kind === "write_module") drafts += 1;
    history.push({ role: "assistant", content: JSON.stringify(wireOf(answer)) });
  };

  const ask = async (trace: ModelCallTrace): Promise<Asked> => {
    try {
      const result = await telemetry.traced(trace, () =>
        generateText({
          model: models.authoring,
          system,
          messages: history,
          output: Output.object({ schema: WIRE_ANSWER_SCHEMA }),
          maxOutputTokens: AUTHORING_MAX_OUTPUT_TOKENS,
          maxRetries: 2,
          runtimeContext: traceContext(trace),
          telemetry: telemetryOptions(telemetry, "acquire.authoring"),
        }),
      );
      return { wire: result.output, text: result.text, problems: [], usage: usageOf(result.usage) };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        return {
          wire: null,
          text: error.text ?? "",
          problems: [`the answer was not in the answer shape: ${causeMessage(error)}`],
          usage: usageOf(error.usage ?? {}),
        };
      }
      throw error;
    }
  };

  return {
    async turn(situation) {
      let usage = ZERO_USAGE;
      const triageCall: TriageCall = {
        model: models.triage,
        modelId: settings.triageModel,
        telemetry,
        trace: traceFor(situation),
      };

      let pages: RenderedPage[] | undefined;
      if (situation.kind === "goal") {
        // The cheap decision first: a goal that names its documentation opens with that page and the
        // authoring model never spends a turn asking for it.
        const triage = await triageGoal(triageCall, context);
        usage = addUsage(usage, triage.usage);
        history.push({ role: "user", content: renderSituation(context, situation) });
        if (triage.urls.length > 0) {
          const answer: ModelAnswer = {
            kind: "read_docs",
            urls: triage.urls,
            note: `Reading the documentation the agent pointed at: ${triage.urls.join(", ")}`,
          };
          record(answer);
          return { answer, usage };
        }
      } else if (situation.kind === "docs") {
        pages = [];
        for (const page of situation.pages) {
          if (page.ok && page.content.length > DOC_SUMMARY_THRESHOLD_CHARS) {
            const summary = await summariseDocPage(triageCall, context, page);
            usage = addUsage(usage, summary.usage);
            pages.push({
              ...page,
              content: summary.content,
              summarised: { from: page.content.length },
            });
          } else {
            pages.push(page);
          }
        }
        history.push({ role: "user", content: renderSituation(context, situation, pages) });
      } else {
        history.push({ role: "user", content: renderSituation(context, situation) });
      }

      const trace: ModelCallTrace = {
        ...traceFor(situation),
        role: "authoring",
        modelId: settings.authoringModel,
      };
      const first = await ask(trace);
      usage = addUsage(usage, first.usage);
      const read = first.wire
        ? readWireAnswer(first.wire, situation.kind)
        : { ok: false as const, problems: first.problems };
      if (read.ok) {
        record(read.answer);
        return { answer: read.answer, usage };
      }

      // The one repair turn: the model's own text stays in the history so it sees what it wrote.
      history.push({ role: "assistant", content: first.text || "(no answer)" });
      history.push({ role: "user", content: renderRepair(read.problems) });
      const second = await ask(trace);
      usage = addUsage(usage, second.usage);
      const reread = second.wire
        ? readWireAnswer(second.wire, situation.kind)
        : { ok: false as const, problems: second.problems };
      if (reread.ok) {
        record(reread.answer);
        return { answer: reread.answer, usage };
      }
      throw new ModelAnswerInvalidError(reread.problems, usage);
    },
  };
}
