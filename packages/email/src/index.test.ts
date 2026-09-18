import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLoginUrl,
  buildPasswordResetUrl,
  sendAccountExistsEmail,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
} from "./index";
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

describe("buildLoginUrl", () => {
  it("joins the console origin and the address on the login door, encoded", () => {
    expect(buildLoginUrl("http://localhost:3001/", "ada@example.com")).toBe(
      "http://localhost:3001/login?email=ada%40example.com",
    );
    expect(buildLoginUrl("https://app.getgraft.ai", "a&redirect=x@example.com")).toBe(
      "https://app.getgraft.ai/login?email=a%26redirect%3Dx%40example.com",
    );
    expect(() => buildLoginUrl("not-an-origin", "a@b.c")).toThrow();
  });
});

describe("sendEmailVerificationEmail and sendAccountExistsEmail (GRA-94)", () => {
  it("send Better Auth's verify URL whole, under the verification template", async () => {
    const { sent, transport } = captureTransport();
    const verifyUrl =
      "http://localhost:3000/api/auth/verify-email?token=tok_1&callbackURL=%2Flogin";
    const result = await sendEmailVerificationEmail(
      { to: "ada@example.com", verifyUrl },
      transport,
    );
    expect(result).toEqual({ delivered: true, transport: "console" });
    expect(sent[0]).toMatchObject({
      to: "ada@example.com",
      template: "emailVerification",
      subject: "Verify your email for Graft",
      dataVariables: { verifyUrl },
      actionUrl: verifyUrl,
    });
  });

  it("send the login link under the account-exists template", async () => {
    const { sent, transport } = captureTransport();
    const loginUrl = "http://localhost:3001/login?email=ada%40example.com";
    await sendAccountExistsEmail({ to: "ada@example.com", loginUrl }, transport);
    expect(sent[0]).toMatchObject({
      template: "accountExists",
      subject: "You already have a Graft account",
      dataVariables: { loginUrl },
      actionUrl: loginUrl,
    });
  });

  it("reject a link that is not a URL rather than emailing a broken one", async () => {
    const { transport } = captureTransport();
    await expect(
      sendEmailVerificationEmail({ to: "a@b.c", verifyUrl: "nope" }, transport),
    ).rejects.toThrow();
    await expect(
      sendAccountExistsEmail({ to: "a@b.c", loginUrl: "nope" }, transport),
    ).rejects.toThrow();
  });
});
