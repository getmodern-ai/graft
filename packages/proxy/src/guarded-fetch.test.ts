import type { Agent as UndiciAgent, MockAgent as UndiciMockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECT_ATTEMPT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, createGuardedFetch } from "./upstream";

/**
 * `createGuardedFetch`'s request and response, with no socket. The fetch takes no dispatcher
 * (GRA-340: nothing outside a test may stand in for the guarded connector), so this suite swaps
 * undici's `Agent` for a `MockAgent` and records what the fetch built it with. The resolver's half
 * of the guard is `upstream.test.ts`'s, over a scripted DNS.
 */

const swap = vi.hoisted(() => ({
  agent: null as UndiciMockAgent | null,
  built: [] as unknown[],
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  // A constructor that answers the test's MockAgent: `new Agent(options)` yields it.
  function Agent(options: unknown) {
    swap.built.push(options);
    return swap.agent;
  }
  return { ...actual, Agent: Agent as unknown as typeof UndiciAgent };
});

const { MockAgent } = await vi.importActual<typeof import("undici")>("undici");

beforeEach(() => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  swap.agent = mock;
  swap.built = [];
});

function mock(): UndiciMockAgent {
  if (!swap.agent) throw new Error("no MockAgent");
  return swap.agent;
}

describe("createGuardedFetch", () => {
  it("opens sockets through the guarded resolver with the vendor fetch's connect timeouts", () => {
    createGuardedFetch();
    expect(swap.built).toEqual([
      {
        connect: {
          lookup: expect.any(Function),
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
          timeout: CONNECT_TIMEOUT_MS,
        },
      },
    ]);
  });

  it("carries a JSON POST to a public host and hands back the platform's Response", async () => {
    let seen: { body: unknown; auth: unknown } | null = null;
    mock()
      .get("https://gateway.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        (request) => {
          const headers = request.headers as Record<string, string>;
          const text = Buffer.from(request.body as Uint8Array).toString("utf8");
          seen = { body: JSON.parse(text), auth: headers.authorization };
          return { id: "chat_1" };
        },
        { headers: { "content-type": "application/json" } },
      );
    const guarded = createGuardedFetch();

    const response = await guarded("https://gateway.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: "chat_1" });
    expect(seen).toEqual({ body: { model: "m" }, auth: "Bearer k" });
  });

  it("returns a redirect to a private address as it came, with no second request", async () => {
    mock()
      .get("https://gateway.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const guarded = createGuardedFetch();

    const response = await guarded("https://gateway.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data");
    // Net connect is off and nothing intercepts the metadata host: a followed redirect would throw.
    mock().assertNoPendingInterceptors();
  });

  it("refuses a private literal before the dispatcher is asked", async () => {
    const guarded = createGuardedFetch();
    await expect(guarded("http://169.254.169.254/latest")).rejects.toThrow(/not a public address/);
  });
});
