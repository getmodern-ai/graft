import { hostSetOf } from "@graft/proxy/credential-source";

/**
 * **Which connection a stock tool runs over** (ADR 0025; GRA-241). A stock tool runs over any
 * connection of its integration, whichever provider made it (the keyring, the gateway, a link
 * provider's relay): it matches a connection when every host its manifest declares is among the
 * hosts the connection reaches, judged as the proxy judges them (`hostSetOf`: lower-case, the
 * primary's host included), so a match is a call the proxy will not refuse `host_not_in_set`. The
 * vendor slug only breaks ties: among several host matches, the one whose slug is the stock tool's
 * vendor is chosen, and with none or several of those nothing is, and the choice is the caller's
 * (`run_tool`'s `connectionId`). Pure: the caller hands it the candidates already narrowed to the
 * agent's scope and to live rows, so a connection outside the scope is never chosen.
 */

export type StockHosts = { vendor: string; hosts: readonly string[] };

type Reach = { vendor: string; hosts: string[]; primaryHost: string | null };

/** Whether a connection reaches every host the stock tool's manifest declares. */
export function stockToolRunsOver(stock: StockHosts, connection: Reach): boolean {
  const reach = hostSetOf(connection);
  return stock.hosts.every((host) => reach.has(host.trim().toLowerCase()));
}

/**
 * Every candidate the stock tool runs over, the vendor's own slug first and otherwise in the order
 * given, and the one chosen: the single match, or the single match of the slug among several.
 */
export function matchStockConnections<C extends Reach>(
  stock: StockHosts,
  candidates: readonly C[],
): { matches: C[]; chosen: C | null } {
  const covering = candidates.filter((candidate) => stockToolRunsOver(stock, candidate));
  const ofSlug = covering.filter((candidate) => candidate.vendor === stock.vendor);
  const matches = [...ofSlug, ...covering.filter((candidate) => candidate.vendor !== stock.vendor)];
  const chosen = matches.length === 1 ? matches[0] : ofSlug.length === 1 ? ofSlug[0] : null;
  return { matches, chosen: chosen ?? null };
}
