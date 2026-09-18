import { z } from "zod";

/**
 * The template registry — the one place a template's Loops transactional id and its
 * data-variables contract are named. Cando's `registry.ts` (ADR 0011), with the one template
 * Graft sends: the password reset (GRA-82). The member invitation stays in Cando, since Graft
 * has no organisation to invite anyone into (ADR 0007).
 *
 * Templates themselves are authored and published in the Loops dashboard (ADR 0021: Loops, not
 * SES, and no in-repo template layer); code references one by its transactional id and supplies
 * data variables. That makes this file the contract between the two: a template edited out from
 * under the code fails the schema here or a logged 400 at send time, instead of silently sending
 * an email with a hole in it.
 *
 * The recipient's address is the envelope, not a variable — every transport takes `to`
 * separately, so no template schema names it.
 */

/**
 * The subject is Loops' to render in a real send — it lives on the published template. The
 * registry still derives one so the console transport can print an honest envelope locally, and
 * so a future Loops 400 can be logged with the human-readable line it concerned.
 */
export type EmailTemplate<Variables extends z.ZodType> = {
  /**
   * The Loops transactional id, from the template's URL in Graft's Loops workspace
   * (`app.loops.so/transactional/<id>`). The console transport never sends it anywhere; the Loops
   * transport's send with a wrong or unpublished id fails as a logged 400.
   */
  transactionalId: string;
  dataVariables: Variables;
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
    // "Reset your getgraft.ai password securely", published in the Graft workspace on 2026-09-18
    // (GRA-82): its one data variable is `resetUrl`, the button's link, and nothing else — the
    // greeting is "Hi," so no name a person typed reaches the template (ADR 0021).
    transactionalId: "cmu63jbxw0m3t01b4aui3mci0",
    dataVariables: passwordResetVariables,
    // A fixed subject on purpose: the reset URL is the only variable, and a token has no
    // business in a subject line.
    subject: () => "Reset your Graft password",
  }),
} as const;

export type TemplateName = keyof typeof templates;
