import { APICallError, RetryError } from "ai";

import { ModelAnswerInvalidError } from "./answer";
import { ModelUnavailableError } from "./routed";
import { ScriptExhaustedError, ScriptMismatchError } from "./scripted";
import type { ModelAdapter } from "./types";

/**
 * A person's own key refused by their provider mid-job (GRA-340): what `withOwnKeyRefusal` throws
 * in place of the provider's 401 or 403, so the job can end on a kind of its own and the console
 * can send the person to Settings rather than suggest the task be worded again. `provider` is the
 * name the person reads, the server's to choose (`@graft/core`'s `modelKeyProviderName`).
 */
export class OwnModelKeyRefusedError extends Error {
  constructor(
    readonly provider: string,
    options?: { cause?: unknown },
  ) {
    super(`Your own model key was refused by ${provider}. Update it in Settings.`, options);
    this.name = "OwnModelKeyRefusedError";
  }
}

/** Whether the provider refused the key itself: a 401 or 403, through the SDK's retry wrapper. */
export function isKeyRefusal(error: unknown): boolean {
  const status = apiCallErrorIn(error)?.statusCode;
  return status === 401 || status === 403;
}

/**
 * The adapter a person's own key builds, with its key refusals named as theirs. Only the job's
 * turns are wrapped: Setup's proposals answer an outcome rather than throw, and say nothing a
 * person acts on.
 */
export function withOwnKeyRefusal(adapter: ModelAdapter, provider: string): ModelAdapter {
  return {
    ...adapter,
    open(context) {
      const conversation = adapter.open(context);
      return {
        async turn(situation) {
          try {
            return await conversation.turn(situation);
          } catch (error) {
            if (isKeyRefusal(error)) throw new OwnModelKeyRefusedError(provider, { cause: error });
            throw error;
          }
        },
      };
    },
  };
}

/**
 * A failed model call as the sentence a person reads in a job's failure (GRA-338). What the
 * provider's package throws carries the endpoint's own words: its error body, or whatever answered
 * at a person's base URL. Echoing that hands the person a reading of an address the server called
 * on their behalf, so the person gets the status and what to check, and the raw message goes to
 * the job's trace alone. Our own errors keep their sentences, since we wrote them; anything else
 * (a response that was not the shape asked for quotes the body too) is one generic sentence.
 */
export function modelFailureSentence(error: unknown): string {
  if (
    error instanceof ModelAnswerInvalidError ||
    error instanceof ModelUnavailableError ||
    error instanceof ScriptExhaustedError ||
    error instanceof ScriptMismatchError ||
    error instanceof OwnModelKeyRefusedError
  ) {
    return error.message;
  }
  if (refusedAsPrivate(error)) {
    return "The model's base URL does not resolve to a public address, so Graft did not call it. Change the base URL in Settings.";
  }
  const call = apiCallErrorIn(error);
  if (!call) return "The model call failed. Try again.";
  const status = call.statusCode;
  if (status === undefined) {
    return "The model provider could not be reached. If you set your own key, check its base URL in Settings; otherwise try again.";
  }
  if (status === 401 || status === 403) {
    return `The model provider refused the key (status ${status}). If you set your own key, check it in Settings.`;
  }
  if (status === 404) {
    return "The model provider answered 404. If you set your own key, check its model ids and base URL in Settings.";
  }
  if (status === 429) {
    return "The model provider is rate limiting this key (status 429). Try again later.";
  }
  if (status >= 500) {
    return `The model provider failed (status ${status}). Try again later.`;
  }
  return `The model provider refused the request (status ${status}).`;
}

/** The provider's error, through the SDK's retry wrapper when it gave up after several. */
function apiCallErrorIn(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error)) return apiCallErrorIn(error.lastError);
  return null;
}

/** The proxy's resolver refusal (`PrivateAddressError`) anywhere in the chain, by name: this package imports nothing from the proxy. */
function refusedAsPrivate(error: unknown, depth = 0): boolean {
  if (depth > 5 || !(error instanceof Error)) return false;
  if (error.name === "PrivateAddressError") return true;
  if (RetryError.isInstance(error) && refusedAsPrivate(error.lastError, depth + 1)) return true;
  return refusedAsPrivate(error.cause, depth + 1);
}
