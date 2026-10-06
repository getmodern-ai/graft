import type { CardData } from "@graft/ask-card/shape";
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
 *
 * An **awaiting** answer — `{ error: "awaiting_approval" | "awaiting_connection" |
 * "awaiting_credential" | "awaiting_scope", reason, url, message, … }` (`approval.ts`,
 * `connection-request.ts`) — is the fourth shape and is **not** an error (GRA-112; ADR 0006 as
 * amended 2026-09-19): the person's step is the tool's answer, and an MCP Apps host renders no view
 * for an error result (ext-apps issue 694), so a card on an `isError: true` result never mounts.
 * `toolAwaiting` returns it with the same JSON and `isError: false`; the `awaiting_` word in the
 * body is what every harness reads, and none reads `isError` for it.
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

/** Whether a body is an awaiting answer: its `error` is an `awaiting_*` word (the header). */
export function isAwaitingAnswer(value: Record<string, unknown>): boolean {
  return typeof value.error === "string" && value.error.startsWith("awaiting_");
}

/**
 * An awaiting answer as a result, not an error (GRA-112): the same text block and
 * `structuredContent` a `toolError` would carry, byte for byte, with `isError: false` said outright
 * so a host that reads the field strictly reads a result.
 */
export function toolAwaiting(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/**
 * The body a gate or an ask flow hands back instead of the tool's result — an awaiting answer, or
 * a refusal — sorted onto the wire: awaiting as a result, anything else as an error. Every path
 * that can answer `awaiting_*` returns through here (`tools/meta.ts`, `tools/execute.ts`,
 * `tools.ts`), so the rule lives once.
 */
export function toolAwaitingOrError(value: Record<string, unknown>): CallToolResult {
  return isAwaitingAnswer(value) ? toolAwaiting(value) : toolError(value);
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
 * is returned as it was. What the text says under a rendered card is `card-client.ts`'s
 * `toolAskResult` (GRA-120), which calls this last. `find_tool`'s Setup offer (GRA-210) puts its
 * `setup` card here too, on a plain result: it is an offer, not an ask (`setup-offer.ts`).
 */
export function withCard(result: CallToolResult, card: CardData | undefined): CallToolResult {
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
