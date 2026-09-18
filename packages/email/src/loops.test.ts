import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLoopsTransport,
  type FetchLike,
  idempotencyKey,
  LOOPS_TRANSACTIONAL_URL,
  transportFromEnv,
} from "./loops";
import { consoleTransport, type SendRequest, sendResultSchema } from "./transport";

const API_KEY = "test-loops-api-key";

const REQUEST: SendRequest = {
  to: "person@example.com",
  subject: "Reset your Graft password",
  template: "passwordReset",
  transactionalId: "loops-id-not-published-yet-password-reset",
  dataVariables: {
    resetUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
  },
  actionUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
};

/** A fetch that always answers with the given status and body — the whole mocked HTTP layer. */
function respondingWith(status: number, body: string): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>().mockResolvedValue(new Response(body, { status }));
}

function successFetch() {
  return respondingWith(200, JSON.stringify({ success: true }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loops transport — request contract", () => {
  it("POSTs to the Loops transactional endpoint", async () => {
    const fetchMock = successFetch();

    await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(LOOPS_TRANSACTIONAL_URL);
    expect(url).toBe("https://app.loops.so/api/v1/transactional");
    expect(init?.method).toBe("POST");
  });

  it("authenticates with the API key as a bearer token and sends JSON", async () => {
    const fetchMock = successFetch();

    await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends exactly the transactional id, the envelope recipient, and the data variables", async () => {
    const fetchMock = successFetch();

    await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      transactionalId: REQUEST.transactionalId,
      email: REQUEST.to,
      dataVariables: REQUEST.dataVariables,
    });
    // The subject stays local: Loops renders its own from the published template.
    expect(body).not.toHaveProperty("subject");
  });

  it("sends an idempotency key within Loops' 100-character limit", async () => {
    const fetchMock = successFetch();

    await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const key = headers["Idempotency-Key"];
    expect(key).toBeDefined();
    expect(key?.length).toBeGreaterThan(0);
    expect(key?.length).toBeLessThanOrEqual(100);
  });

  it("derives the same key for a retried send, so Loops can dedupe it", () => {
    expect(idempotencyKey(REQUEST)).toBe(idempotencyKey({ ...REQUEST }));
  });

  it("derives a different key when the logical send differs", () => {
    const otherRecipient = idempotencyKey({ ...REQUEST, to: "other@example.com" });
    const otherToken = idempotencyKey({
      ...REQUEST,
      dataVariables: {
        ...REQUEST.dataVariables,
        resetUrl: "https://app.getgraft.ai/reset-password?token=tok_456",
      },
    });

    expect(otherRecipient).not.toBe(idempotencyKey(REQUEST));
    expect(otherToken).not.toBe(idempotencyKey(REQUEST));
  });

  it("prefixes the key with the template name, so a duplicate is attributable in the dashboard", () => {
    expect(idempotencyKey(REQUEST)).toMatch(/^passwordReset-[0-9a-f]{64}$/);
  });
});

describe("loops transport — response mapping", () => {
  it("maps a 2xx to delivered, in the shared result shape", async () => {
    const result = await createLoopsTransport(API_KEY, successFetch()).send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: true, transport: "loops" });
  });

  it("returns the identical result shape as the console transport — asserted, not assumed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const loopsResult = await createLoopsTransport(API_KEY, successFetch()).send(REQUEST);
    const consoleResult = await consoleTransport.send(REQUEST);

    expect(sendResultSchema.parse(loopsResult)).toEqual({ delivered: true, transport: "loops" });
    expect(sendResultSchema.parse(consoleResult)).toEqual({
      delivered: true,
      transport: "console",
    });
  });

  it("names itself consistently in the result and on the transport", async () => {
    const transport = createLoopsTransport(API_KEY, successFetch());

    const result = await transport.send(REQUEST);

    expect(result.transport).toBe(transport.name);
  });

  it("maps a 400 — the unpublished-template pre-rollout failure — to a logged non-delivery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = respondingWith(
      400,
      JSON.stringify({ success: false, message: "Transactional email is not published" }),
    );

    const result = await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: false, transport: "loops" });
    expect(error).toHaveBeenCalledTimes(1);
    const [line, context] = error.mock.calls[0] ?? [];
    expect(String(line)).toContain("Loops rejected the send");
    expect(context).toMatchObject({
      template: "passwordReset",
      status: 400,
      message: "Transactional email is not published",
    });
  });

  it.each([[404], [409], [500]])(
    "maps a %i to a logged non-delivery, never a throw",
    async (status) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = respondingWith(status, JSON.stringify({ success: false, message: "nope" }));

      const result = await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

      expect(sendResultSchema.parse(result)).toEqual({ delivered: false, transport: "loops" });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toMatchObject({ template: "passwordReset", status });
    },
  );

  it("reports a non-JSON error body raw rather than logging undefined", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = respondingWith(502, "Bad Gateway");

    await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    expect(error.mock.calls[0]?.[1]).toMatchObject({ status: 502, message: "Bad Gateway" });
  });

  it("maps a network failure to a logged non-delivery instead of rejecting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const result = await createLoopsTransport(API_KEY, fetchMock).send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: false, transport: "loops" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ template: "passwordReset" });
  });
});

describe("transportFromEnv", () => {
  it("selects the Loops transport when GRAFT_LOOPS_API_KEY is set", () => {
    expect(transportFromEnv("a-real-key").name).toBe("loops");
  });

  it("selects the console transport when GRAFT_LOOPS_API_KEY is unset", () => {
    expect(transportFromEnv(undefined)).toBe(consoleTransport);
  });

  it("treats an empty string as unset — the env layer's emptyStringAsUndefined posture", () => {
    expect(transportFromEnv("")).toBe(consoleTransport);
  });
});
