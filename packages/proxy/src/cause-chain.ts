/**
 * Walking an error's `cause` chain — the one walker this package has. `upstream.ts` classifies a
 * fetch failure with it and `failure.ts` flattens a failure onto the wide event with it; a host
 * that wants the same line on its own log takes `describeCauseChain` from here rather than keeping
 * a twin, because the proxy may import nothing from the host (`index.ts`) while the host may
 * import from here.
 *
 * Total over anything that can be thrown. It reads `name`, `message` and `cause` and nothing else —
 * no stack, no other properties — so an error that carried a vendor body, a request body or a
 * credential cannot put it on a log line through here.
 */

/**
 * How many links are read. Five is more than anything on either side of the boundary builds — the
 * deepest is three (a classified sentence, an operator's summary, the provider's own error) — so
 * the cap is a guard against a chain nobody designed rather than a limit anybody will meet.
 */
export const MAX_CAUSE_DEPTH = 5;

/** What a truncated chain ends with, so the cap cannot make a partial record read as a complete one. */
const TRUNCATED = "...";

export type CauseChain = {
  /** The error itself first, then each `cause` in turn. A non-`Error` link is always the last. */
  links: unknown[];
  /** True when a further link existed past `MAX_CAUSE_DEPTH` and went unread. */
  truncated: boolean;
};

/**
 * The links of a failure's `cause` chain, outermost first, up to `MAX_CAUSE_DEPTH`. A non-`Error`
 * cannot carry a `cause`, so it ends the chain; so does a link already read — a `cause` can point
 * back up its own chain, and this runs on the failure path, where the cost of a hang is a failure
 * that never gets recorded. A cycle is not called truncation: the chain does continue, but only
 * back into something already read, so there is nothing further to tell anybody about.
 */
export function causeChain(error: unknown): CauseChain {
  const links: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null) {
    if (seen.has(current)) break;
    if (links.length >= MAX_CAUSE_DEPTH) return { links, truncated: true };
    seen.add(current);
    links.push(current);
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return { links, truncated: false };
}

/**
 * `name: message` down the chain, joined by ` <- `, ending in `...` when the cap cut it short — one
 * line of plain text, which is the form that survives a log drain: an `Error` placed in a
 * structured field serialises as `{}`. Empty for nothing at all.
 */
export function describeCauseChain(error: unknown): string {
  const { links, truncated } = causeChain(error);
  const text = links.map((link) =>
    link instanceof Error ? `${link.name}: ${link.message}` : String(link),
  );
  if (truncated) text.push(TRUNCATED);
  return text.join(" <- ");
}

/** Whether any `Error` in the chain carries one of `names` — how a wrapped failure is classified. */
export function hasCauseNamed(error: unknown, names: readonly string[]): boolean {
  return causeChain(error).links.some((link) => link instanceof Error && names.includes(link.name));
}
