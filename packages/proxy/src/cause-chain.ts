/**
 * Walking an error's `cause` chain — the one walker this package has. `upstream.ts` classifies a
 * fetch failure with it and `failure.ts` flattens a failure onto the wide event with it; a host
 * that wants the same line on its own log takes `describeCauseChain` from here rather than keeping
 * a twin, because the proxy may import nothing from the host (`index.ts`) while the host may
 * import from here.
 *
 * Total over anything that can be thrown. Of an `Error` it reads `name`, `message`, a string `code`
 * and `cause` and nothing else — no stack, no other properties — so an error that carried a vendor
 * body, a request body or a credential cannot put it on a log line through here. Of a link that is
 * not an `Error` it reads the sentence fields (`describeLink`), the one reading a whole value gets;
 * the only way such a link reaches the proxy's failure path is as the cause of the proxy's own or
 * undici's error, because what a host-bound dependency threw arrives with its cause already
 * dropped (`HostDependencyError`, `failure.ts`).
 */

/**
 * How many links are read. Five is more than anything on either side of the boundary builds — the
 * deepest is three (a classified sentence, an operator's summary, the provider's own error) — so
 * the cap is a guard against a chain nobody designed rather than a limit anybody will meet.
 */
export const MAX_CAUSE_DEPTH = 5;

/** What a truncated chain ends with, so the cap cannot make a partial record read as a complete one. */
export const TRUNCATED = "...";

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
 * One link as text: `name [code]: message` for an `Error` — the `[code]` only when the link carries
 * a string `code`, which is how Node spells a system error (`ENOTFOUND`, `ECONNREFUSED`) and what
 * undici's `fetch failed` never says on its own — and `String(link)` for anything else. The runner's
 * `describeCause` (`packages/runner/src/runner.mjs`) and `@graft/mcp`'s `errorMessage` render a
 * cause in this same form, so one thrown value reads alike in the wide event, on a sandbox's stderr
 * and in a job's result (GRA-80).
 *
 * A link that is not an `Error` is read as GRA-60 reads a thrown value: a provider SDK throws the
 * vendor API's error body as a plain object (`@blaxel/core` on a refused create or drive call), and
 * `String` of that is `[object Object]`, so a plain object is the first non-empty string among
 * `message`, `error` and `detail`, with `code` or `status` in parentheses when one is set, and its
 * JSON only when it has no sentence in it; anything else is `String(link)`. `errorMessage` in
 * `@graft/mcp` takes this same function for what it is handed, so a Blaxel body reads the same
 * whether it was thrown or sat in a cause.
 */
export function describeLink(link: unknown): string {
  if (link instanceof Error) {
    const code = (link as { code?: unknown }).code;
    return typeof code === "string"
      ? `${link.name} [${code}]: ${link.message}`
      : `${link.name}: ${link.message}`;
  }
  if (typeof link === "object" && link !== null) {
    const body = link as Record<string, unknown>;
    const text = [body.message, body.error, body.detail].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const code = [body.code, body.status].find(
      (value) => typeof value === "number" || (typeof value === "string" && value.length > 0),
    );
    if (text !== undefined) return code === undefined ? text : `${text} (${code})`;
    try {
      return JSON.stringify(link);
    } catch {
      return String(link);
    }
  }
  return String(link);
}

/**
 * `name [code]: message` down the chain, joined by ` <- `, ending in `...` when the cap cut it
 * short — one line of plain text, which is the form that survives a log drain: an `Error` placed in
 * a structured field serialises as `{}`. Empty for nothing at all.
 */
export function describeCauseChain(error: unknown): string {
  const { links, truncated } = causeChain(error);
  const text = links.map(describeLink);
  if (truncated) text.push(TRUNCATED);
  return text.join(" <- ");
}

/** Whether any `Error` in the chain carries one of `names` — how a wrapped failure is classified. */
export function hasCauseNamed(error: unknown, names: readonly string[]): boolean {
  return causeChain(error).links.some((link) => link instanceof Error && names.includes(link.name));
}
