import { z } from "zod";

/**
 * The template registry — the one place an email's name, its data-variables contract and its
 * subject are declared. Cando's `registry.ts` (ADR 0011), with the one template Graft sends: the
 * password reset (GRA-82). The member invitation stays in Cando, since Graft has no organisation to
 * invite anyone into (ADR 0007).
 *
 * The registry names nothing about how a template is rendered or sent: that is the transport's
 * (ADR 0021, GRA-90). The open form's console transport prints the subject and the variables; the
 * hosted form's transport, in the private package, maps each name here to a template of its own
 * and is the one place a vendor's template id is written. A variable renamed in a hosted template
 * therefore fails there, at send time, and the schema here is what a caller is held to.
 *
 * The recipient's address is the envelope, not a variable — every transport takes `to`
 * separately, so no template schema names it.
 */

export type EmailTemplate<Variables extends z.ZodType> = {
  dataVariables: Variables;
  /**
   * The subject the console transport prints and a self-rendering transport sends. A hosted
   * template carries its own, kept the same by hand.
   */
  subject: (variables: z.infer<Variables>) => string;
};

export const passwordResetVariables = z.object({
  /**
   * The reset screen for this request: `<console origin>/reset-password?token=<token>`. The one
   * variable the email exists to carry — nothing user-controlled belongs in this template.
   */
  resetUrl: z.url(),
});

export type PasswordResetVariables = z.infer<typeof passwordResetVariables>;

/** Identity with inference: ties each `subject` callback to its own `dataVariables` schema. */
function defineTemplate<Variables extends z.ZodType>(
  template: EmailTemplate<Variables>,
): EmailTemplate<Variables> {
  return template;
}

export const templates = {
  passwordReset: defineTemplate({
    dataVariables: passwordResetVariables,
    // A fixed subject on purpose: the reset URL is the only variable, and a token has no
    // business in a subject line.
    subject: () => "Reset your Graft password",
  }),
} as const;

export type TemplateName = keyof typeof templates;

/** Every template name, for a transport that maps them to templates of its own and wants to prove it covers all. */
export const TEMPLATE_NAMES = Object.keys(templates) as readonly TemplateName[];
