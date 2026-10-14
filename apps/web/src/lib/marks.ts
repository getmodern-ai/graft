import type { SetupHarness } from "@graft/core/setup/harness";

/**
 * Which mark the console draws for an integration and for an agent's harness (GRA-288), as pure
 * decisions; `components/marks.tsx` holds the artwork and draws them.
 */

/** A harness the console has a mark for, or `generic`, the Material extension glyph. */
export type HarnessMarkId =
  | "claude"
  | "claude-code"
  | "codex"
  | "chatgpt"
  | "cursor"
  | "hermes"
  | "openclaw"
  | "generic";

/** Hosts a client may name as its `client_uri`, read only when its name matched nothing. */
const URI_HOSTS: readonly [string, HarnessMarkId][] = [
  ["claude.ai", "claude"],
  ["anthropic.com", "claude"],
  ["chatgpt.com", "chatgpt"],
  ["openai.com", "chatgpt"],
  ["cursor.com", "cursor"],
  ["cursor.sh", "cursor"],
];

const hostOf = (uri: string): string | null => {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The mark for an agent's harness, read off what the client registered at its consent (ADR 0018):
 * the name first, Claude Code and Codex before the chat products whose names they contain, then
 * the host of its `client_uri`. A static-token agent records neither and gets `generic`, as does a
 * client none of them matches: the name is the registrant's own claim, so it picks artwork and
 * never vouches for anything.
 */
export function harnessMark(
  clientName: string | null | undefined,
  clientUri?: string | null,
): HarnessMarkId {
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude code") || name.includes("claude-code")) return "claude-code";
  if (name.includes("codex")) return "codex";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude")) return "claude";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("hermes")) return "hermes";
  if (name.includes("openclaw")) return "openclaw";
  const host = clientUri ? hostOf(clientUri) : null;
  if (host) {
    for (const [suffix, mark] of URI_HOSTS) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return mark;
    }
  }
  return "generic";
}

/** The mark for a harness Setup offers; *Another MCP client* is the generic one. */
export function harnessMarkOfSetup(harness: SetupHarness): HarnessMarkId {
  return harness === "other" ? "generic" : harness;
}

/**
 * The key a bundled integration mark is filed under: the vendor slug lower-cased with underscores
 * read as hyphens, so a starter's id (`google-drive`) and the catalogue's app (`google_drive`)
 * find the same file.
 */
export function integrationMarkKey(slug: string): string {
  return slug.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * The image an integration mark draws: the directory's `logoUrl` first, then the bundled file,
 * skipping any that failed to load; null means initials. `failed` is what the component's
 * `onError` collected, keyed by the source itself, so a new `logoUrl` is tried afresh.
 */
export function integrationMarkSource(
  logoUrl: string | null | undefined,
  bundled: string | null | undefined,
  failed: readonly string[] = [],
): string | null {
  for (const candidate of [logoUrl, bundled]) {
    if (candidate && !failed.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * The letters an integration with no artwork is drawn with: the first letters of the first two
 * words of its name, or of its slug's parts when it has no name; one letter for a one-word name.
 */
export function markInitials(name: string | null | undefined, slug?: string | null): string {
  const source = name?.trim() || slug?.trim() || "";
  const words = source.split(/[\s_\-.]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words
    .slice(0, 2)
    .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? "");
  return letters.join("").toUpperCase() || "?";
}
