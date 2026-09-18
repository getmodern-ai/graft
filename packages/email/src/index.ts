import { type PasswordResetVariables, templates } from "./registry";
import { consoleTransport, type EmailTransport, type SendResult } from "./transport";

/**
 * `@graft/email` — the seam for transactional mail (ADR 0021; GRA-82, reshaped by GRA-90). Cando's
 * `@cando/email` (ADR 0011), less the member invitation Graft has no organisation for (ADR 0007),
 * the display-name sanitizer that existed for it, and — the reshaping — the vendor transport, which
 * is the hosted form's and lives in the private package (ADR 0002); the one email here carries
 * nothing a person typed.
 *
 * Transactional mail is email the product sends a person because something concerns them — not
 * a connection (no vendor, no agent acting) and not a handoff (nothing to approve). The package
 * exports one typed send function per email, built on the template registry and the transport
 * seam. Callers get the same `SendResult` shape whichever backing is live, and a send that fails
 * REJECTS rather than returning a broken shape — the caller decides whether that may fail its own
 * operation (for the reset hook: never).
 */

export {
  type PasswordResetVariables,
  passwordResetVariables,
  TEMPLATE_NAMES,
  type TemplateName,
  templates,
} from "./registry";
export {
  consoleTransport,
  type EmailTransport,
  type SendRequest,
  type SendResult,
  sendResultSchema,
} from "./transport";

/**
 * The reset screen's address for one token: `<console origin>/reset-password?token=<token>`.
 *
 * Built here rather than taken from Better Auth's `url` argument on purpose: that URL points at
 * the *API's* GET callback (`<auth base>/reset-password/:token`), and the reset screen is a
 * console route under `GRAFT_CONSOLE_URL` — the origin every handoff URL is built on (ADR 0006),
 * which in development is the Vite origin and not the API's. The token rides in a query parameter
 * because that is where the route's search schema reads it; `resetPassword` consumes the token
 * itself, so no API round trip is lost by skipping the callback. `new URL` both validates the
 * origin and normalises a trailing slash.
 */
export function buildPasswordResetUrl(consoleUrl: string, token: string): string {
  return `${new URL(consoleUrl).origin}/reset-password?token=${encodeURIComponent(token)}`;
}

export type PasswordResetEmail = {
  /** The account's address — the envelope recipient, not a template variable. */
  to: string;
  /** From `buildPasswordResetUrl` — passed in whole so the caller owns token and origin. */
  resetUrl: string;
};

/**
 * Sends the password-reset email.
 *
 * Nothing in this template is user-controlled — the reset URL is built from the configured
 * console origin and Better Auth's token. The variables still go through the registry schema, so
 * a renamed variable fails loudly at the one seam that owns the contract.
 *
 * `transport` is deps-last, like service deps elsewhere in the repo: callers ignore it, tests
 * replace it.
 */
export async function sendPasswordResetEmail(
  email: PasswordResetEmail,
  transport: EmailTransport = consoleTransport,
): Promise<SendResult> {
  const template = templates.passwordReset;

  const variables: PasswordResetVariables = template.dataVariables.parse({
    resetUrl: email.resetUrl,
  });

  return transport.send({
    to: email.to,
    subject: template.subject(variables),
    template: "passwordReset",
    dataVariables: variables,
    actionUrl: variables.resetUrl,
  });
}
