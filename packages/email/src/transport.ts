import { z } from "zod";

import type { TemplateName } from "./registry";

/**
 * The transport seam: how a validated send leaves the process (ADR 0021; GRA-82, reshaped by GRA-90).
 *
 * Mail is a seam like the sandbox, the keyring and the toolbox store (ADR 0002): the open form's
 * backing is the console transport below, and the hosted form's — a vendor's API — lives in the
 * private package and is handed in through `Backings.mail`. Every backing MUST answer the same
 * `SendResult` shape. That is a lesson paid for in a predecessor codebase, where the dev path
 * returned `undefined` while the real path returned an object, and every caller recorded every local
 * send as failed. `sendResultSchema` pins the contract so a test can hold any backing to it.
 */

export const sendResultSchema = z.object({
  /** Whether this transport accepted the mail. The console "delivers" by printing. */
  delivered: z.boolean(),
  /** Which transport handled the send — `console` here, the private package's own name there. */
  transport: z.string().min(1),
});

export type SendResult = z.infer<typeof sendResultSchema>;

/**
 * Everything a transport needs, already validated by the façade. Nothing here names a vendor: a
 * backing that renders through a hosted template maps `template` to its own id; one that renders
 * itself has the subject and the variables.
 */
export type SendRequest = {
  /** The envelope recipient. Deliberately not a data variable — see the registry. */
  to: string;
  /** The registry's subject line; a hosted template renders its own, the console prints this one. */
  subject: string;
  /** The registry key — what a backing renders, or maps to a template of its own. */
  template: TemplateName;
  /** The template's validated data variables. */
  dataVariables: Record<string, string>;
  /** The one link the email exists to carry, printed on its own line so terminals link it. */
  actionUrl: string;
};

export type EmailTransport = {
  /** The name the boot line and every `SendResult` carry. */
  name: string;
  send(request: SendRequest): Promise<SendResult>;
};

/**
 * The console transport: the open form's whole mail stack, on a laptop and in the self-hosted
 * image alike — the envelope, the data variables, and the action URL on a line of its own, which
 * every modern terminal renders clickable, so a reset is read out of `docker compose logs graft`.
 * The hosted form replaces it with the private package's transport and falls back to it when that
 * package answers no `mail`.
 *
 * It returns `delivered: true`: printing is this transport's delivery, and returning anything
 * falsy (or nothing, as the predecessor did) teaches callers that local sends fail.
 */
export const consoleTransport: EmailTransport = {
  name: "console",
  send(request) {
    const variables = Object.entries(request.dataVariables).map(
      ([key, value]) => `│   ${key}: ${value}`,
    );
    console.log(
      [
        "",
        "┌─ Transactional mail (console transport — the open form's; nothing left the machine)",
        `│ template: ${request.template}`,
        `│ to:       ${request.to}`,
        `│ subject:  ${request.subject}`,
        "│ data variables:",
        ...variables,
        "│",
        `│ ➜ ${request.actionUrl}`,
        "└─",
        "",
      ].join("\n"),
    );
    return Promise.resolve({ delivered: true, transport: "console" });
  },
};
