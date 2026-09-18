import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmtpTransport, RENDERERS_COVER_REGISTRY, render, type SendMailLike } from "./smtp";
import { type SendRequest, sendResultSchema } from "./transport";

const REQUEST: SendRequest = {
  to: "person@example.com",
  subject: "Reset your Graft password",
  template: "passwordReset",
  dataVariables: { resetUrl: "https://graft.example/reset-password?token=tok_123" },
  actionUrl: "https://graft.example/reset-password?token=tok_123",
};

const OPTIONS = {
  url: "smtps://user:pass@smtp.example.com:465",
  from: "Graft <no-reply@graft.example>",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("smtp transport — the message", () => {
  it("sends the registry's subject and the rendered bodies from the configured sender", async () => {
    const sendMail = vi.fn<SendMailLike>().mockResolvedValue({ accepted: [REQUEST.to] });

    const result = await createSmtpTransport(OPTIONS, sendMail).send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: true, transport: "smtp" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      from: OPTIONS.from,
      to: REQUEST.to,
      subject: "Reset your Graft password",
    });
    expect(message?.text).toContain(REQUEST.actionUrl);
    expect(message?.html).toContain(`href="${REQUEST.actionUrl}"`);
  });

  it("renders the hosted template's copy — heading, one sentence, the button, the aside, the footer", () => {
    const { text, html } = render(REQUEST);
    for (const line of [
      "Reset your password",
      "We received a request to reset your Graft password.",
      "If you did not ask for this, you can ignore this email.",
    ]) {
      expect(text).toContain(line);
      expect(html).toContain(line);
    }
    expect(html).toContain("Reset password");
    expect(html).toContain("&copy; Graft");
    // The text body carries the link on a line of its own, as the console transport prints it.
    expect(text.split("\n")).toContain(REQUEST.actionUrl);
  });

  it("escapes what it interpolates into HTML, so a link can never close an attribute", () => {
    const { html } = render({
      ...REQUEST,
      dataVariables: { resetUrl: 'https://graft.example/reset-password?token=a"><script>' },
    });
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("has a renderer for every template the registry declares", () => {
    expect(RENDERERS_COVER_REGISTRY).toBe(true);
  });
});

describe("smtp transport — failure", () => {
  it("maps a refusal to a logged non-delivery, never a throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sendMail = vi
      .fn<SendMailLike>()
      .mockRejectedValue(new Error("535 Authentication failed"));

    const result = await createSmtpTransport(OPTIONS, sendMail).send(REQUEST);

    expect(sendResultSchema.parse(result)).toEqual({ delivered: false, transport: "smtp" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ template: "passwordReset", to: REQUEST.to });
  });

  it("names itself consistently in the result and on the transport", async () => {
    const transport = createSmtpTransport(OPTIONS, vi.fn<SendMailLike>().mockResolvedValue({}));
    expect((await transport.send(REQUEST)).transport).toBe(transport.name);
  });
});
