import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { ModelAnswerInvalidError } from "./answer";
import { modelFailureSentence } from "./model-failure";
import { ScriptExhaustedError } from "./scripted";

/** What a person reads when the model call fails (GRA-338): the status and what to check, never the endpoint's words. */

const BODY = '{"error":{"message":"ami-id i-0abc123 instance-identity secret"}}';

function apiCallError(statusCode: number | undefined, message = "ami-id i-0abc123") {
  return new APICallError({
    message,
    url: "https://gateway.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: BODY,
  });
}

describe("modelFailureSentence", () => {
  it("names the status and never the provider's message or body", () => {
    for (const [status, phrase] of [
      [401, "refused the key (status 401)"],
      [403, "refused the key (status 403)"],
      [404, "answered 404"],
      [429, "rate limiting"],
      [502, "failed (status 502)"],
      [400, "refused the request (status 400)"],
    ] as const) {
      const sentence = modelFailureSentence(apiCallError(status));
      expect(sentence).toContain(phrase);
      expect(sentence).not.toContain("i-0abc123");
    }
  });

  it("reads through the SDK's retry wrapper, and says unreachable when no status came back", () => {
    const retried = new RetryError({
      message: "Failed after 3 attempts. Last error: ami-id i-0abc123",
      reason: "maxRetriesExceeded",
      errors: [apiCallError(undefined)],
    });
    expect(modelFailureSentence(retried)).toMatch(/^The model provider could not be reached/);
  });

  it("says a private address was refused when the guard's error is anywhere in the chain", () => {
    const refusal = Object.assign(new Error("gateway.example resolves to 10.0.0.5"), {
      name: "PrivateAddressError",
    });
    const failed = new TypeError("fetch failed", { cause: refusal });
    const call = new APICallError({
      message: "Cannot connect to API: fetch failed",
      url: "https://gateway.example/v1",
      requestBodyValues: {},
      cause: failed,
    });
    expect(modelFailureSentence(call)).toMatch(
      /^The model's base URL does not resolve to a public/,
    );
  });

  it("keeps the sentences Graft wrote itself, and says nothing specific of anything else", () => {
    const invalid = new ModelAnswerInvalidError(["draft is missing"], {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(modelFailureSentence(invalid)).toBe(invalid.message);
    const exhausted = new ScriptExhaustedError("goal", 1);
    expect(modelFailureSentence(exhausted)).toBe(exhausted.message);
    expect(modelFailureSentence(new Error(BODY))).toBe("The model call failed. Try again.");
  });
});
