import type { ModelKeyOutput } from "@graft/core";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * The person's own model key (ADR 0014: bring your own key, and your `acquire` jobs run on your
 * provider and nobody else's). One resource, three verbs (`apps/server/src/api.ts`, "The person's
 * own model key"). The key travels in the `PUT` body to the server and to nothing else here: no
 * query reads one back, and the server answers the provider, the model ids and when it was set —
 * write-only after entry, as a connection's credential is.
 */

export type ModelKey = Jsonified<ModelKeyOutput>;
export type ModelKeyProvider = ModelKey["provider"];

export const modelKeyKeys = {
  current: ["me", "model-key"] as const,
};

export const modelKeyQuery = queryOptions({
  queryKey: modelKeyKeys.current,
  queryFn: () => api<{ modelKey: ModelKey | null }>("/me/model-key"),
});

export type SetModelKeyInput = {
  provider: ModelKeyProvider;
  apiKey: string;
  authoringModel?: string | null;
  triageModel?: string | null;
  baseUrl?: string | null;
};

export function setModelKey(input: SetModelKeyInput) {
  return api<{ modelKey: ModelKey }>("/me/model-key", { method: "PUT", body: input });
}

export function removeModelKey() {
  return api<{ deleted: boolean }>("/me/model-key", { method: "DELETE" });
}

/** The two providers the server accepts, with the words the card shows for each. */
export const MODEL_KEY_PROVIDERS: { value: ModelKeyProvider; label: string; keyHint: string }[] = [
  { value: "anthropic", label: "Anthropic", keyHint: "An Anthropic API key (sk-ant-…)." },
  {
    value: "openai",
    label: "OpenAI, or an OpenAI-compatible gateway",
    keyHint: "An OpenAI API key (sk-…), or the gateway's key with its base URL below.",
  },
];
