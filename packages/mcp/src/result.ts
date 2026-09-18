import type { AskCard } from "@graft/ask-card/shape";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * What a tool call answers with, in the three shapes this server uses.
 *
 * Every answer is JSON in a text block, because that is what every harness renders; a plain object
 * rides in `structuredContent` too, for a client that reads it. A **refusal** — Graft's own decision
 * not to run something — is `{ error: "refused", reason, message }`, the proxy's shape for the same
 * situation (`@graft/proxy`'s refusal body), so what an agent reads from a tool and from a vendor
 * call is the same vocabulary. A **failure** is whatever the run said, verbatim; the run path's
 * shape is `{ error, exitCode, stderrTail }` (`run.ts`). Both set `isError`, which is MCP's way of
 * telling a harness the model should read the content as a problem rather than a result.
 */

export function toolResult(value: unknown): CallToolResult {
  const normalised = value === undefined ? null : value;
  return {
    content: [{ type: "text", text: JSON.stringify(normalised) }],
    ...(isPlainObject(normalised) ? { structuredContent: normalised } : {}),
  };
}

export type Refusal = {
  error: "refused";
  reason: string;
  message: string;
} & Record<string, unknown>;

export function refusal(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): Refusal {
  return { ...details, error: "refused", reason, message };
}

export function toolRefusal(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): CallToolResult {
  return toolError(refusal(reason, message, details));
}

/** A failure the run reported, in its own shape, marked as an error for the harness. */
export function toolError(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

/**
 * The answer of a meta-tool whose ticket has not landed. The name is in the list from day one so
 * the list is stable (GRA-19); the body names the ticket so an agent can say what is missing.
 */
export function notAvailableYet(what: string, ticket: string): CallToolResult {
  return toolError({
    error: "not_available_yet",
    ticket,
    message: `${what} is not available yet on this deployment — it arrives with ${ticket}. Say so rather than retrying.`,
  });
}

/**
 * The ask card's data beside an awaiting answer (GRA-84; `ask-card.ts`): in `structuredContent`
 * alone, never in the text block. The text is what the model reads and what GRA-55 fixed — the
 * `url`, the `message`, the `reason` — and the card is the host's to render, so it rides where a
 * host looks and a model's transcript does not change by a character. Without a card the result
 * is returned as it was.
 */
export function withCard(result: CallToolResult, card: AskCard | undefined): CallToolResult {
  if (!card) return result;
  return { ...result, structuredContent: { ...(result.structuredContent ?? {}), card } };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What `tools/call` handed over as arguments, as a record — the SDK allows `undefined`. */
export function argumentsOf(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : {};
}
