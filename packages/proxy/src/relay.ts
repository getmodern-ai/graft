import type { RelayHeaderRules, RelayPlugin } from "./types";

/**
 * The relay engine's own half (ADR 0019; ported from Cando's broker relay, CAN-563 to CAN-567,
 * with the broker's constants taken out and left as parameters). A relay scheme does not
 * present a credential to the vendor: it rewrites the request the ladder resolved — vendor host,
 * path and query — into a request to an upstream proxy that holds the credential and answers with
 * the vendor's response. Which upstream, and how the vendor URL is carried to it, is the plugin's
 * (`RelayPlugin.relay`); how the caller's headers travel is this file's, as a pure function over a
 * rule table, so every plugin applies the same header discipline and a rule learned at one upstream
 * is data rather than a second copy of the loop.
 *
 * Two lessons the rules encode. The prefix is applied to a header that *already* carries it, so a
 * caller cannot smuggle a stripped `authorization` or `cookie` past the outgoing policy by naming it
 * `<prefix>authorization` — the upstream strips exactly one prefix, and a doubled one reaches the
 * vendor as a harmless unknown header (Greptile on Cando's PR #525). And a header the upstream
 * refuses is dropped rather than prefixed: a broker's proxy answers `400 Unsupported header` for a
 * prefixed `user-agent`, which Node's fetch sends on every request and the outgoing policy rightly
 * keeps for an ordinary vendor — Cando's first relayed call in production failed on a header nobody
 * chose (CAN-566). The predicates below are the surface; the sets stay private (CAN-567) so nothing
 * can mutate a rule process-wide.
 *
 * There is no catalogue of plugins here (GRA-103): a connection's provider hands the proxy the
 * plugin on the resolution (`ProxyRelay.plugin`), the gateway's from `gateway-relay.ts` and a
 * hosted provider's from beside itself, so this package names no upstream but the open form's own.
 */

/** Forward every caller header under its own name, drop nothing: a gateway that fronts the vendor itself. */
export const PASSTHROUGH_RELAY_RULES: RelayHeaderRules = {
  prefix: null,
  passThrough: [],
  refuse: [],
  refusePrefixes: [],
};

/** Whether the rules forward a caller header under its own name despite a prefix. */
export function relayPassesThrough(name: string, rules: RelayHeaderRules): boolean {
  const lower = name.toLowerCase();
  return rules.passThrough.some((entry) => entry.toLowerCase() === lower);
}

/** Whether the rules drop a caller header because the upstream would refuse it. */
export function relayRefuses(name: string, rules: RelayHeaderRules): boolean {
  const lower = name.toLowerCase();
  return (
    rules.refuse.some((entry) => entry.toLowerCase() === lower) ||
    rules.refusePrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
  );
}

/**
 * The caller's headers as the upstream takes them, rewritten in place: a refused header is gone; a
 * pass-through header keeps its name; every other header is renamed under the prefix, when there
 * is one. Runs over the headers the outgoing policy and the token sweep have already cleaned
 * (`headers.ts`, `token.ts`), so what it renames is what would have reached the vendor. The plugin
 * sets the upstream's own headers *after* this, so a caller header cannot collide with them.
 */
export function relayHeaders(headers: Headers, rules: RelayHeaderRules): void {
  const callers = [...headers.entries()];
  for (const [name] of callers) headers.delete(name);
  for (const [name, value] of callers) {
    if (relayRefuses(name, rules)) continue;
    if (rules.prefix === null || relayPassesThrough(name, rules)) headers.set(name, value);
    else headers.set(`${rules.prefix}${name}`, value);
  }
}

/** A plugin's rules with a connection's overrides on top — what one relayed call runs under. */
export function relayRulesOf(
  plugin: Pick<RelayPlugin, "rules">,
  overrides: Partial<RelayHeaderRules> | undefined,
): RelayHeaderRules {
  return { ...plugin.rules, ...overrides };
}
