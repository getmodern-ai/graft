import { describe, expect, it, vi } from "vitest";

import { checkModelKey } from "./key-check";

/** The save's one call to the provider (GRA-340), against a scripted `fetch`. */

function answering(status: number) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response("{}", { status });
  });
}

describe("checkModelKey", () => {
  it("asks Anthropic's models list with the key in its header, and reads 200 as accepted", async () => {
    const fetch = answering(200);
    const check = await checkModelKey(
      { provider: "anthropic", apiKey: "sk-ant-1", baseUrl: null },
      { fetch },
    );
    expect(check).toEqual({ outcome: "accepted" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(init?.headers).toMatchObject({ "x-api-key": "sk-ant-1" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks OpenAI's, or the gateway's under its base URL, with a bearer key", async () => {
    const fetch = answering(200);
    await checkModelKey({ provider: "openai", apiKey: "sk-1", baseUrl: null }, { fetch });
    await checkModelKey(
      { provider: "openai", apiKey: "gw-1", baseUrl: "https://gateway.example/v1/" },
      { fetch },
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://gateway.example/v1/models",
    ]);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer gw-1" });
  });

  it("reads 401 alone as refused, and any other status as unchecked", async () => {
    const input = { provider: "openai", apiKey: "not-a-key", baseUrl: null } as const;
    expect(await checkModelKey(input, { fetch: answering(401) })).toEqual({
      outcome: "refused",
      status: 401,
    });
    // A restricted key denied the list may still generate: it is saved, with a warning.
    expect(await checkModelKey(input, { fetch: answering(403) })).toEqual({
      outcome: "unchecked",
      reason: "status",
      status: 403,
    });
    expect(await checkModelKey(input, { fetch: answering(404) })).toEqual({
      outcome: "unchecked",
      reason: "status",
      status: 404,
    });
    expect(await checkModelKey(input, { fetch: answering(503) })).toMatchObject({
      outcome: "unchecked",
    });
  });

  it("is unchecked when the provider is unreachable or slower than the bound", async () => {
    const input = { provider: "anthropic", apiKey: "k", baseUrl: null } as const;
    const unreachable = async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    };
    expect(await checkModelKey(input, { fetch: unreachable })).toEqual({
      outcome: "unchecked",
      reason: "unreachable",
    });
    // A provider that never answers: the bound's abort ends the wait.
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await checkModelKey(input, { fetch: hang, timeoutMs: 20 })).toEqual({
      outcome: "unchecked",
      reason: "timeout",
    });
  });

  it("reads the address guard's refusal as not public", async () => {
    const refusal = Object.assign(new Error("gateway.example resolves to 10.0.0.5"), {
      name: "PrivateAddressError",
    });
    const guarded = async () => {
      throw new TypeError("fetch failed", { cause: refusal });
    };
    expect(
      await checkModelKey(
        { provider: "openai", apiKey: "k", baseUrl: "https://gateway.example/v1" },
        { fetch: guarded },
      ),
    ).toEqual({ outcome: "not_public" });
  });
});
