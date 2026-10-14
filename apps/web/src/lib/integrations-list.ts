import type { IntegrationAttentionReason } from "@graft/core";

import { count } from "./format";
import { type ReconnectAction, reconnectActionsOf } from "./integration-page";
import type {
  Integration,
  IntegrationConnection,
  SuggestedIntegration,
} from "./integration-queries";
import { providerLabel } from "./provider-name";

/**
 * The Integrations screen's Connected tab (GRA-321; Figma 2059:7655), as pure decisions over the
 * integrations read (GRA-291) and the suggested read (GRA-305): which rows a search leaves, in
 * which order, and the sentences each row and the banner say. `integrations.index.tsx` and
 * `components/integration/integrations-table.tsx` draw what these answer.
 */

/** The list's tabs: what the person connected, and the directory to connect more from (GRA-322). */
export const INTEGRATIONS_LIST_TABS = ["connected", "discover"] as const;
export type IntegrationsListTab = (typeof INTEGRATIONS_LIST_TABS)[number];

/** The longest `q` or `custom` the URL carries; a pasted docs link is well under it. */
const SEARCH_PARAM_MAX = 2000;

/** The Integrations screen's search: Discover's own two params ride only with `tab=discover`. */
export type IntegrationsListSearch = {
  tab?: "discover";
  /** Discover's search box, as a deep link fills it. */
  q?: string;
  /**
   * Flow C's hand-off (GRA-323): present, *Add a custom API* is open; its value is the name typed
   * or the docs link pasted into Discover's search, empty when nothing was. `customApiSeed`
   * (`integrations-discover.ts`) reads it.
   */
  custom?: string;
};

/** A param's text: the router reads `?q=123` as a number, which is still what was typed. */
const textParam = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.slice(0, SEARCH_PARAM_MAX)
    : typeof value === "number"
      ? String(value)
      : undefined;

/** `?tab=discover` alone sticks in the URL: Connected is the default, so `/integrations` is it. */
export function readIntegrationsListSearch(
  search: Record<string, unknown>,
): IntegrationsListSearch {
  if (search.tab !== "discover") return {};
  const q = textParam(search.q)?.trim();
  const custom = textParam(search.custom);
  return {
    tab: "discover",
    ...(q ? { q } : {}),
    // Empty is kept: *Add a custom API* with nothing typed opens the dialog all the same.
    ...(custom !== undefined ? { custom } : {}),
  };
}

export type IntegrationsSort = "attention" | "recent" | "name";

/** The sort control's choices, for the `Select` primitive's `items`. */
export const INTEGRATIONS_SORT_ITEMS: readonly { value: IntegrationsSort; label: string }[] = [
  { value: "attention", label: "Needs you first" },
  { value: "recent", label: "Last used" },
  { value: "name", label: "Name" },
];

export function readIntegrationsSort(value: unknown): IntegrationsSort | null {
  return INTEGRATIONS_SORT_ITEMS.some((item) => item.value === value)
    ? (value as IntegrationsSort)
    : null;
}

/**
 * Worst first, as the server orders a row's own connections (`worstAttention` in
 * `@graft/core`'s `integration.service.ts`): signed out, a sign-in never finished, a credential
 * never entered, then a provider the deployment stopped enabling.
 */
const ATTENTION_RANK: Record<IntegrationAttentionReason, number> = {
  consent_required: 0,
  awaiting_consent: 1,
  awaiting_credential: 2,
  provider_unavailable: 3,
};

const byName = (a: Integration, b: Integration) =>
  a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
  a.vendor.localeCompare(b.vendor);

/** Newest call first, a row never used last. */
const byLastUsed = (a: Integration, b: Integration) => {
  if (a.lastUsedAt === b.lastUsedAt) return 0;
  if (a.lastUsedAt === null) return 1;
  if (b.lastUsedAt === null) return -1;
  return b.lastUsedAt.localeCompare(a.lastUsedAt);
};

const attentionRank = (row: Integration) =>
  row.needsAttention ? ATTENTION_RANK[row.needsAttention.reason] : Number.POSITIVE_INFINITY;

const COMPARATORS: Record<IntegrationsSort, (a: Integration, b: Integration) => number> = {
  // A row that needs the person, worst first; then the rest by when they were last used.
  attention: (a, b) => attentionRank(a) - attentionRank(b) || byLastUsed(a, b) || byName(a, b),
  recent: (a, b) => byLastUsed(a, b) || byName(a, b),
  name: byName,
};

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Whether a row answers a search: every word of the query appears in its name, its slug, one of
 * its connections' names or hosts, or one of its agents' names, ignoring case. A blank query
 * leaves every row.
 */
export function integrationMatches(row: Integration, query: string): boolean {
  const terms = words(query);
  if (terms.length === 0) return true;
  const haystack = [
    row.displayName,
    row.vendor,
    ...row.connections.flatMap((connection) => [connection.displayName, ...connection.hosts]),
    ...row.agents.map((agent) => agent.name),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The rows a search leaves, in the chosen order; the input is left as it was. */
export function integrationsListOf(
  rows: readonly Integration[],
  { query, sort }: { query: string; sort: IntegrationsSort },
): Integration[] {
  return rows.filter((row) => integrationMatches(row, query)).sort(COMPARATORS[sort]);
}

/** No live connection of the row is connected, so none of its tools can run. */
export function isIntegrationUnusable(row: Integration): boolean {
  return !row.connections.some((connection) => connection.state === "connected");
}

/** "Claude", "Claude and Codex", "3 agents", or "your agents" when none can use it. */
export function agentsPhrase(agents: readonly { name: string }[]): string {
  const [first, second] = agents;
  if (!first) return "your agents";
  if (!second) return first.name;
  if (agents.length === 2) return `${first.name} and ${second.name}`;
  return `${agents.length} agents`;
}

function reasonPhrase(reason: IntegrationAttentionReason, connection: IntegrationConnection) {
  switch (reason) {
    case "consent_required":
      return "signed out";
    case "awaiting_consent":
      return "sign-in not finished";
    case "awaiting_credential":
      return "no credential entered yet";
    case "provider_unavailable":
      return `${providerLabel(connection.provider)} is turned off on this server`;
  }
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The connection the row's attention names, when it still has one. */
export function attentionConnectionOf(row: Integration): IntegrationConnection | null {
  const id = row.needsAttention?.connectionId;
  return row.connections.find((connection) => connection.id === id) ?? null;
}

/**
 * The red line under a row's name, or null for a row that needs nothing (GRA-282's words). With
 * every connection down it says who is cut off; with another connection still working it names
 * the one that needs the person, since the integration still runs.
 */
export function attentionSentence(row: Integration): string | null {
  const connection = attentionConnectionOf(row);
  if (!row.needsAttention || !connection) return null;
  const phrase = reasonPhrase(row.needsAttention.reason, connection);
  if (isIntegrationUnusable(row)) {
    return `${capitalise(phrase)}, so ${agentsPhrase(row.agents)} can't use it`;
  }
  return `${connection.displayName}: ${phrase}`;
}

/** The muted line under a row's name when it needs nothing: the address, or how many connections. */
export function integrationSubline(row: Integration): string {
  if (row.connections.length > 1) return count(row.connections.length, "connection");
  return row.connections[0]?.hosts[0] ?? row.vendor;
}

/**
 * The Tools cell: the count, or, when no connection of the row is connected, that its tools can't
 * run until the person reconnects (GRA-282: never "paused").
 */
export function toolsCell(row: Integration): { text: string; blocked: boolean } {
  if (row.toolCount > 0 && isIntegrationUnusable(row)) {
    return { text: `${row.toolCount} can't run until you reconnect`, blocked: true };
  }
  return { text: String(row.toolCount), blocked: false };
}

/** The Used by cell's words: the one agent's name, or how many. */
export function usedByLabel(row: Integration): string {
  const [only] = row.agents;
  if (row.agents.length === 1 && only) return only.name;
  if (row.agents.length === 0) return "No agent";
  return count(row.agents.length, "agent");
}

/**
 * The row's Sign in, through the connection that needs the person and the way that connection is
 * signed in again on its own page (`reconnectActionsOf`: a consent, or the credential dialog).
 * Null when it has nothing the person can enter here (a link provider, a gateway, a provider the
 * operator turned off), and the row offers its menu instead.
 */
export function signInOf(
  row: Integration,
): { connection: IntegrationConnection; action: ReconnectAction } | null {
  const connection = attentionConnectionOf(row);
  if (!connection) return null;
  const [action] = reconnectActionsOf(connection, connection.state);
  return action ? { connection, action } : null;
}

/**
 * The banner's integrations (ADR 0001 as amended 2026-10-14): the suggested read is one entry per
 * ask, so each vendor once, newest ask first, less any the person has connected since the read.
 */
export function suggestedVendorsOf(
  suggestions: readonly SuggestedIntegration[],
  integrations: readonly Pick<Integration, "vendor">[],
): SuggestedIntegration[] {
  const connected = new Set(integrations.map((row) => row.vendor));
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (connected.has(suggestion.vendor) || seen.has(suggestion.vendor)) return false;
    seen.add(suggestion.vendor);
    return true;
  });
}

/** How many names the banner's second line spells out before "and N more". */
const BANNER_NAMES = 4;

/** "Your agents asked about 4 integrations you haven't connected", and the names under it. */
export function suggestedBanner(
  suggested: readonly Pick<SuggestedIntegration, "displayName">[],
): { title: string; names: string } | null {
  if (suggested.length === 0) return null;
  const title =
    suggested.length === 1
      ? "Your agents asked about an integration you haven't connected"
      : `Your agents asked about ${suggested.length} integrations you haven't connected`;
  const names = suggested.map((suggestion) => suggestion.displayName);
  const shown = names.slice(0, BANNER_NAMES);
  const rest = names.length - shown.length;
  const line =
    rest > 0
      ? `${shown.join(", ")} and ${rest} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
        : (shown[0] ?? "");
  return { title, names: line };
}
