import { createTransport } from "nodemailer";

import { type TemplateName, type TemplateVariables, templates } from "./registry";
import type { EmailTransport, SendRequest } from "./transport";

/**
 * The SMTP transport — the open form's working backing for the mail seam (ADR 0021 as amended for
 * GRA-92), beside the console transport that is its floor. Every self-host has an SMTP relay — a
 * mailbox provider's, SES's SMTP endpoint, a company mail server — so this is the one backing that
 * ties nobody to a vendor: `GRAFT_SMTP_URL` names the relay and its credentials, `GRAFT_MAIL_FROM`
 * the sender, and nothing else is configured. nodemailer carries the protocol; this file carries
 * the seam's two rules — one `SendResult` shape, and a send that never throws — and the rendering.
 *
 * Rendering is this transport's, as the Loops transport's template ids are its own: the open
 * registry declares a template's variables and subject and nothing about how it looks, so a
 * transport that sends through no hosted template renders here, from a map every registry name
 * must appear in (`Record<TemplateName, …>` — a template the registry adds without a renderer is a
 * type error, not a blank email). The copy and the colours are the hosted template's, kept the
 * same by hand: a person reset from a self-host and one reset from Graft Cloud read the same email.
 */

export type SmtpTransportOptions = {
  /** `smtp://user:pass@host:587` or `smtps://…:465` — nodemailer's URL form, credentials inside it. */
  url: string;
  /** The `From` header: an address, or `Name <address>`. */
  from: string;
};

/** What the transport calls — nodemailer's `sendMail` narrowed to the fields used, so a test hands in a function. */
export type SendMailLike = (message: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<unknown>;

/** A rendered email: the plain-text body every client can show, and the small HTML body most do. */
export type RenderedEmail = { text: string; html: string };

// The console's tokens, as the hosted template uses them (ADR 0017's palette, converted to hex).
const COLOUR = {
  heading: "#0F0C0A",
  text: "#24211E",
  muted: "#6E6966",
  accent: "#FD6A41",
  rule: "#EBE6E3",
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The one frame every email here is drawn in — a white card on a light page, Arial, the heading,
 * the sentences, one button and a footer — so a second template is its copy and nothing else.
 */
function frame(input: {
  heading: string;
  body: string;
  button: { label: string; url: string };
  aside: string;
}): string {
  const year = new Date().getUTCFullYear();
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#F9F9F9;font-family:Arial,Helvetica,sans-serif;color:${COLOUR.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:8px;padding:32px 40px">
<tr><td style="font-size:24px;line-height:32px;font-weight:500;color:${COLOUR.heading};padding:0 0 12px">${escapeHtml(input.heading)}</td></tr>
<tr><td style="font-size:16px;line-height:24px;padding:0 0 28px">${escapeHtml(input.body)}</td></tr>
<tr><td style="padding:0 0 32px"><a href="${escapeHtml(input.button.url)}" style="display:inline-block;background:${COLOUR.accent};color:${COLOUR.heading};text-decoration:none;font-size:16px;font-weight:600;padding:12px 16px;border-radius:8px">${escapeHtml(input.button.label)}</a></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:${COLOUR.muted};padding:0 0 32px">${escapeHtml(input.aside)}</td></tr>
<tr><td style="border-top:1px solid ${COLOUR.rule};font-size:12px;line-height:18px;color:${COLOUR.muted};text-align:center;padding:24px 0 0">&copy; Graft ${year}</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * One renderer per registry template. The subject is the registry's; the text body puts the link
 * on a line of its own, as the console transport does, so a client that shows no HTML still has
 * something to click.
 */
export const RENDERERS: {
  [Name in TemplateName]: (variables: TemplateVariables[Name]) => RenderedEmail;
} = {
  passwordReset: ({ resetUrl }) => ({
    text: [
      "Reset your password",
      "",
      "We received a request to reset your Graft password. Open this link to choose a new one:",
      "",
      resetUrl,
      "",
      "If you did not ask for this, you can ignore this email.",
    ].join("\n"),
    html: frame({
      heading: "Reset your password",
      body: "We received a request to reset your Graft password.",
      button: { label: "Reset password", url: resetUrl },
      aside: "If you did not ask for this, you can ignore this email.",
    }),
  }),
  emailVerification: ({ verifyUrl }) => ({
    text: [
      "Verify your email",
      "",
      "Confirm this address to finish creating your Graft account. The link works for 24 hours:",
      "",
      verifyUrl,
      "",
      "If you did not create a Graft account, you can ignore this email.",
    ].join("\n"),
    html: frame({
      heading: "Verify your email",
      body: "Confirm this address to finish creating your Graft account. The link works for 24 hours.",
      button: { label: "Verify email", url: verifyUrl },
      aside: "If you did not create a Graft account, you can ignore this email.",
    }),
  }),
  accountExists: ({ loginUrl }) => ({
    text: [
      "You already have an account",
      "",
      "Someone, probably you, tried to create a Graft account with this address, but it already has one. Sign in to continue; if you have forgotten your password, you can reset it from the sign-in screen:",
      "",
      loginUrl,
      "",
      "If this was not you, nothing about your account has changed and no action is needed.",
    ].join("\n"),
    html: frame({
      heading: "You already have an account",
      body: "Someone, probably you, tried to create a Graft account with this address, but it already has one. Sign in to continue. If you have forgotten your password, you can reset it from the sign-in screen.",
      button: { label: "Sign in to Graft", url: loginUrl },
      aside: "If this was not you, nothing about your account has changed and no action is needed.",
    }),
  }),
};

/** The registry's template names and the renderers' keys are one set — held by the type, and by a test. */
export const RENDERERS_COVER_REGISTRY = Object.keys(templates).every((name) => name in RENDERERS);

/**
 * Renders a validated request. The variables arrived through the registry's schema, so the cast to
 * the template's variable type is the one the façade already proved.
 */
export function render(request: SendRequest): RenderedEmail {
  const renderer = RENDERERS[request.template] as (
    variables: Record<string, string>,
  ) => RenderedEmail;
  return renderer(request.dataVariables);
}

/**
 * Sends through the relay `url` names. Every refusal and every dropped connection maps to
 * `delivered: false` and a log line naming the template — never a throw — so the operation that
 * asked for the email (the reset hook) is never failed by its mail. `sendMail` is deps-last like the
 * façade's transport: callers get nodemailer's, tests hand in a function.
 */
export function createSmtpTransport(
  options: SmtpTransportOptions,
  sendMail: SendMailLike = createTransport(options.url).sendMail.bind(createTransport(options.url)),
): EmailTransport {
  return {
    name: "smtp",
    async send(request) {
      const rendered = render(request);
      try {
        await sendMail({
          from: options.from,
          to: request.to,
          subject: request.subject,
          text: rendered.text,
          html: rendered.html,
        });
        return { delivered: true, transport: "smtp" };
      } catch (error) {
        console.error("Transactional mail failed — the SMTP relay refused or was unreachable", {
          template: request.template,
          to: request.to,
          error,
        });
        return { delivered: false, transport: "smtp" };
      }
    },
  };
}
