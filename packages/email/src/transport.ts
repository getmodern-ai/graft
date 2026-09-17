import { z } from "zod";

/**
 * The transport seam: how a validated send leaves the process. Cando's `packages/email/src/transport.ts`
 * (ADR 0011; Cando's CAN-162), copied for GRA-82 with the variable renamed.
 *
 * Two implementations exist — this console transport, and the Loops transport in `loops.ts`
 * (a single POST to Loops' transactional endpoint). Both MUST return the same `SendResult`
 * shape. That is a lesson paid for in a predecessor codebase, where the dev path returned
 * `undefined` while the real path returned an object, and every caller recorded every local send
 * as failed. `sendResultSchema` pins the contract so a test can hold any future transport to it.
 */

export const sendResultSchema = z.object({
  /** Whether this transport accepted the mail. The console "delivers" by printing. */
  delivered: z.boolean(),
  /** Which transport handled the send, so logs and tests can tell the paths apart. */
  transport: z.enum(["console", "loops"]),
});

export type SendResult = z.infer<typeof sendResultSchema>;

/** Everything a transport needs, already validated by the façade. */
export type SendRequest = {
  /** The envelope recipient. Deliberately not a data variable — see the registry. */
  to: string;
  /** The registry's derived subject line; Loops renders its own, the console prints this one. */
  subject: string;
  /** The registry key, for humans reading logs. */
  template: string;
  /** The Loops transactional id — what a real send would reference. */
  transactionalId: string;
  /** The template's validated data variables. */
  dataVariables: Record<string, string>;
  /** The one link the email exists to carry, printed on its own line so terminals link it. */
  actionUrl: string;
};

export type EmailTransport = {
  name: SendResult["transport"];
  send(request: SendRequest): Promise<SendResult>;
};

/**
 * The console transport: local development's whole mail stack — and, until a Loops account
 * exists, the hosted form's too, where the line lands in the server's log group.
 *
 * With no `GRAFT_LOOPS_API_KEY` configured there is nothing to send through, and the point of a
 * reset is the link — so the transport prints the envelope, the data variables, and the action
 * URL on a line of its own, which every modern terminal renders clickable.
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
        "┌─ Transactional mail (console transport — no GRAFT_LOOPS_API_KEY, nothing left the machine)",
        `│ template: ${request.template} (loops transactional id: ${request.transactionalId})`,
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
