import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPasswordResetUrl, sendPasswordResetEmail } from "./index";
import type { EmailTransport, SendRequest } from "./transport";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A transport that records what it was asked to send. */
function captureTransport() {
  const sent: SendRequest[] = [];
  const transport: EmailTransport = {
    name: "console",
    send: (request) => {
      sent.push(request);
      return Promise.resolve({ delivered: true, transport: "console" as const });
    },
  };
  return { sent, transport };
}

describe("buildPasswordResetUrl", () => {
  it("joins the console origin and the token on the reset route convention", () => {
    expect(buildPasswordResetUrl("https://app.getgraft.ai", "tok_123")).toBe(
      "https://app.getgraft.ai/reset-password?token=tok_123",
    );
  });

  it("normalises a trailing slash on the origin, and drops a path — the route is the console's", () => {
    expect(buildPasswordResetUrl("http://localhost:3001/", "tok_123")).toBe(
      "http://localhost:3001/reset-password?token=tok_123",
    );
  });

  it("URL-encodes the token, so a hostile token cannot change the URL", () => {
    expect(buildPasswordResetUrl("https://app.getgraft.ai", "a&error=x")).toBe(
      "https://app.getgraft.ai/reset-password?token=a%26error%3Dx",
    );
  });

  it("throws on an origin that is not a URL, rather than emailing a broken link", () => {
    expect(() => buildPasswordResetUrl("not-an-origin", "tok_123")).toThrow();
  });
});

describe("sendPasswordResetEmail", () => {
  const EMAIL = {
    to: "person@example.com",
    resetUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
  };

  it("sends the envelope and the validated variables through the transport", async () => {
    const { sent, transport } = captureTransport();

    const result = await sendPasswordResetEmail(EMAIL, transport);

    expect(result).toEqual({ delivered: true, transport: "console" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "person@example.com",
      template: "passwordReset",
      actionUrl: EMAIL.resetUrl,
      dataVariables: { resetUrl: EMAIL.resetUrl },
    });
    expect(sent[0]?.subject).toContain("password");
  });

  it("rejects a send whose reset URL is not a URL", async () => {
    const { transport } = captureTransport();

    await expect(
      sendPasswordResetEmail({ ...EMAIL, resetUrl: "not-a-url" }, transport),
    ).rejects.toThrow();
  });

  it("prints the reset URL to the console by default — the local mail stack", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendPasswordResetEmail(EMAIL);

    expect(result).toEqual({ delivered: true, transport: "console" });
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(EMAIL.resetUrl);
    expect(output).toContain(EMAIL.to);
  });
});
