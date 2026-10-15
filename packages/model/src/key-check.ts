import type { ModelProviderName } from "./provider";

/**
 * One cheap, bounded call that says whether a provider takes a key (GRA-340): the provider's
 * models list, which costs no tokens and answers 401 to a key it does not know. Asked when a
 * person saves their own key, so "not-a-key" is refused at the form rather than at every build.
 * The caller hands the HTTP client: the server's is the proxy's address-guarded fetch, since a
 * base URL is the person's choice (GRA-338).
 *
 * Only a refusal of the key refuses the save. A provider that cannot be reached, is slow, or
 * answers anything else (a gateway with no models route answers 404) leaves the key unchecked,
 * and the save goes ahead with a warning: a key is not refused on a guess.
 */

export type ModelKeyCheckInput = {
  provider: ModelProviderName;
  apiKey: string;
  baseUrl: string | null;
};

export type ModelKeyCheck =
  /** The provider answered the list with the key. */
  | { outcome: "accepted" }
  /**
   * The provider does not know the key: 401. A 403 is not this: a restricted key may be denied the
   * list and still generate, so it is `unchecked` and the save goes ahead with a warning.
   */
  | { outcome: "refused"; status: number }
  /** The base URL resolved to an address the guard refuses. */
  | { outcome: "not_public" }
  /** Nothing said whether the key is good: no answer in time, no connection, or another status. */
  | { outcome: "unchecked"; reason: "timeout" | "unreachable" | "status"; status?: number };

/** How long the check may take before the save goes ahead unchecked. */
export const MODEL_KEY_CHECK_TIMEOUT_MS = 5_000;

const DEFAULT_BASE: Record<ModelProviderName, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

/**
 * The models list for the provider, under the base URL the provider's package would use: the
 * SDKs take a custom base URL in place of their default, version path included.
 */
function modelsRequest(input: ModelKeyCheckInput): {
  url: string;
  headers: Record<string, string>;
} {
  let base = input.baseUrl ?? DEFAULT_BASE[input.provider];
  // A loop rather than a trailing `/+$` pattern, which a long run of slashes makes slow.
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (input.provider === "anthropic") {
    return {
      url: `${base}/models?limit=1`,
      headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${input.apiKey}` } };
}

export async function checkModelKey(
  input: ModelKeyCheckInput,
  options: { fetch: typeof globalThis.fetch; timeoutMs?: number },
): Promise<ModelKeyCheck> {
  const { url, headers } = modelsRequest(input);
  const signal = AbortSignal.timeout(options.timeoutMs ?? MODEL_KEY_CHECK_TIMEOUT_MS);
  let status: number;
  try {
    const response = await options.fetch(url, { method: "GET", headers, signal });
    status = response.status;
    // The body is not read: the status is the whole answer, and a page need not be waited for.
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (namedInChain(error, "PrivateAddressError")) return { outcome: "not_public" };
    if (signal.aborted || namedInChain(error, "TimeoutError")) {
      return { outcome: "unchecked", reason: "timeout" };
    }
    return { outcome: "unchecked", reason: "unreachable" };
  }
  if (status >= 200 && status < 300) return { outcome: "accepted" };
  if (status === 401) return { outcome: "refused", status };
  return { outcome: "unchecked", reason: "status", status };
}

function namedInChain(error: unknown, name: string, depth = 0): boolean {
  if (depth > 5 || !(error instanceof Error)) return false;
  return error.name === name || namedInChain(error.cause, name, depth + 1);
}
