/**
 * A URL with its trailing slashes trimmed, by index rather than by a regular expression over caller
 * input: `/\/+$/` backtracks polynomially on a long run of slashes (CodeQL's polynomial-redos rule,
 * first on #167 for `setupUrl`, then on the six URL builders that still spelled it). **Browser-safe**
 * and import-free, so `oauth.rules.ts`, `link.rules.ts` and `setup.rules.ts` read it without pulling
 * anything into the console's bundle; `@graft/mcp`'s `handoff.ts` reads it through `@graft/core`.
 * `@graft/proxy` and `@graft/model` depend on nothing here and carry a loop of their own.
 */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}
