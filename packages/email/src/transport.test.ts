import { afterEach, describe, expect, it, vi } from "vitest";

import { consoleTransport, type SendRequest, sendResultSchema } from "./transport";

const REQUEST: SendRequest = {
  to: "person@example.com",
  subject: "Reset your Graft password",
  template: "passwordReset",
  dataVariables: {
    resetUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
  },
  actionUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("console transport", () => {
  it("prints the envelope, the variables and the action URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await consoleTransport.send(REQUEST);

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("person@example.com");
    expect(output).toContain("Reset your Graft password");
    expect(output).toContain("resetUrl: https://app.getgraft.ai/reset-password?token=tok_123");
    expect(output).toContain("template: passwordReset");
  });

  it("prints the action URL on a line of its own, so terminals render it clickable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await consoleTransport.send(REQUEST);

    const lines = log.mock.calls.flatMap((call) => call.join(" ").split("\n"));
    const urlLine = lines.find((line) => line.includes(REQUEST.actionUrl));
    expect(urlLine).toBeDefined();
    // Nothing after the URL — a trailing character would break the terminal's link detection.
    expect(urlLine?.trimEnd().endsWith(REQUEST.actionUrl)).toBe(true);
  });

  /**
   * A predecessor's dev transport returned `undefined` while the real one returned an object, and
   * callers recorded every local send as failed. The schema is the contract every transport must
   * satisfy.
   */
  it("returns the shared result shape, never undefined", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await consoleTransport.send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: true, transport: "console" });
  });

  it("names itself consistently in the result and on the transport", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await consoleTransport.send(REQUEST);

    expect(result.transport).toBe(consoleTransport.name);
  });

  it("pins the contract the hosted transport also satisfies: a delivered flag and a named transport", () => {
    expect(sendResultSchema.safeParse({ delivered: false, transport: "hosted" }).success).toBe(
      true,
    );
    expect(sendResultSchema.safeParse(undefined).success).toBe(false);
    expect(sendResultSchema.safeParse({ delivered: true }).success).toBe(false);
    expect(sendResultSchema.safeParse({ delivered: true, transport: "" }).success).toBe(false);
  });
});
