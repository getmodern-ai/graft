import type { ConnectBody } from "@graft/server/api";

import { formatRelative } from "./format";
import type { SuggestedIntegration } from "./integration-queries";
import type { DirectoryEntry } from "./setup-queries";

/**
 * The Integrations screen's Discover tab (GRA-322; Figma 2043:7028, no results 2118:14864), as pure
 * decisions over the directory reads and the suggested read (GRA-305): what the search box means,
 * what each tile says, what Connect asks the person, and what Flow C (GRA-323) is handed.
 * `components/integration/discover-tab.tsx` draws what these answer.
 */

/**
 * What the search box holds: nothing (the suggestions and *Popular*), words to search the
 * directory with, or a link to an API's docs, which Discover hands to Flow C instead of searching.
 */
export type DiscoverSearch =
  | { kind: "browse" }
  | { kind: "search"; query: string }
  | { kind: "docs"; url: string };

/** A host and a path, with no scheme: `docs.acme.dev/api`, `www.acme.dev`. */
const BARE_LINK = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

/**
 * A pasted link is an `http(s)` URL, or a bare host that is plainly one (it starts `www.` or carries
 * a path); a name with a dot alone (`cal.com`) is still searched, since the directory may hold it.
 */
export function readDiscoverSearch(text: string): DiscoverSearch {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "browse" };
  if (!/\s/.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        if (url.hostname.includes(".")) return { kind: "docs", url: url.toString() };
      } catch {
        // Not a URL after all: searched as words.
      }
    } else if (BARE_LINK.test(trimmed) && (/^www\./i.test(trimmed) || trimmed.includes("/"))) {
      return { kind: "docs", url: `https://${trimmed}` };
    }
  }
  return { kind: "search", query: trimmed };
}

/** The search box's prompt, with the directory's own count (the backing's `total`). */
export function discoverPlaceholder(total: number | undefined): string {
  if (!total) return "Search integrations, or paste a link to any API docs";
  return `Search ${total.toLocaleString("en")} ${total === 1 ? "integration" : "integrations"}, or paste a link to any API docs`;
}

/**
 * The line under a suggestion's name (ADR 0001 as amended 2026-10-14): which of the person's
 * agents asked, and nothing of what it was asked in a chat, which Graft never sees.
 */
export function suggestionLine(
  suggestion: Pick<SuggestedIntegration, "agent" | "ask">,
  now: Date = new Date(),
): string {
  const agent = suggestion.agent.name;
  if (suggestion.ask.state === "open") return `${agent} is waiting on this one`;
  return `${agent} asked for it ${formatRelative(suggestion.ask.askedAt, now)}`;
}

/**
 * What a suggestion's Connect does. An open ask is answered where it stands, on its request, so
 * the agent waiting on it hears; a closed one connects through the directory like any tile, and a
 * vendor the directory does not hold goes to Flow C with its docs (or its name) instead.
 */
export type SuggestionConnect =
  | { kind: "request"; pendingActionId: string }
  | { kind: "directory"; slug: string };

export function suggestionConnect(
  suggestion: Pick<SuggestedIntegration, "vendor" | "ask">,
): SuggestionConnect {
  return suggestion.ask.state === "open"
    ? { kind: "request", pendingActionId: suggestion.ask.pendingActionId }
    : { kind: "directory", slug: suggestion.vendor };
}

/** What a suggestion the directory does not hold hands Flow C: its docs when the ask named them. */
export function suggestionCustom(
  suggestion: Pick<SuggestedIntegration, "displayName" | "docsUrl">,
): string {
  return suggestion.docsUrl ?? suggestion.displayName;
}

/**
 * Flow C's seed (GRA-323) from Discover's `custom` param: a docs link, or the name the person
 * typed and found nothing for. `docsUrl` is null for a name; `name` is empty for a link.
 */
export function customApiSeed(custom: string): { name: string; docsUrl: string | null } {
  const read = readDiscoverSearch(custom);
  return read.kind === "docs"
    ? { name: "", docsUrl: read.url }
    : { name: custom.trim(), docsUrl: null };
}

/** The access the connect dialog offers (ADR 0008 as amended 2026-10-14), Full access first. */
export type ConnectAccess = NonNullable<ConnectBody["access"]>;

export function accessOptions(
  name: string,
): readonly { value: ConnectAccess; label: string; description: string }[] {
  return [
    {
      value: "full",
      label: "Full access",
      description: `Agents that can use it now can build ${name} tools and use them without asking. Tools that can delete still ask.`,
    },
    {
      value: "ask",
      label: "Ask me first",
      description: "Each agent asks before it builds or uses each tool.",
    },
  ];
}

/**
 * What the connect dialog knows of how an integration connects: the directory entry's word, or
 * nothing for a suggestion, which names a vendor and not an entry; the server's answer decides.
 */
export type ConnectKindKnown = { name: string; connect?: DirectoryEntry["connect"] | null };

/** The dialog's sentence on what connecting takes, by how the directory says it connects. */
export function connectStepSentence(entry: ConnectKindKnown): string {
  switch (entry.connect) {
    case "link":
      return `Sign in with ${entry.name} to finish. Graft never sees your password.`;
    case "keyless":
      return `${entry.name} needs no key, so it connects at once.`;
    case "form":
      return `Next, add your ${entry.name} key. It is entered once and never shown again.`;
    default:
      return `Choose what your agents can do with ${entry.name}, then connect it.`;
  }
}

/** The dialog's primary button, by the same. */
export function connectButtonLabel(entry: ConnectKindKnown): string {
  switch (entry.connect) {
    case "link":
      return `Sign in with ${entry.name}`;
    case "form":
      return "Continue";
    default:
      return "Connect";
  }
}

/** The vendors the person holds a live connection of, so a tile says Open rather than Connect. */
export function connectedVendors(integrations: readonly { vendor: string }[]): Set<string> {
  return new Set(integrations.map((row) => row.vendor));
}

/** The heading over a search's grid: how many match, or the category's name. */
export function resultsHeading(query: string, category: string | null, total: number): string {
  if (query) {
    return `${total.toLocaleString("en")} ${total === 1 ? "integration matches" : "integrations match"} “${query}”`;
  }
  return category ?? "Popular";
}
