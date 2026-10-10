import { isAuthScheme } from "@graft/proxy";
import type { AuthScheme } from "@graft/proxy/types";

/**
 * Which way the harness proves a stock tool's reads (ADR 0025; GRA-240). **Replay**, the default and
 * the only mode `pnpm run test` ever runs, answers every read from the tool's recording and holds no
 * secret. **Live** sends the same dry run's reads to the vendor through the real proxy, over a
 * connection the environment supplies, and fails a tool whose vendor stopped answering what the
 * recording holds. Writes stop at the dry-run preview in both, since the token carries the claim.
 *
 * Live is GRA-247's nightly job on `main`, and a maintainer's check before a rebuild:
 *
 *   GRAFT_STOCK_LIVE=1 GRAFT_STOCK_LIVE_CONNECTIONS='{"hubspot":{"scheme":"bearer","credential":{"token":"…"}}}' \
 *     pnpm --filter @graft/stock test:live
 *
 * Turbo's strict env mode withholds all three variables from `pnpm run test`, so a laptop or CI
 * holding them still replays there; only a direct run of the package's script goes live.
 */

export const LIVE_VARIABLE = "GRAFT_STOCK_LIVE";
export const LIVE_CONNECTIONS_VARIABLE = "GRAFT_STOCK_LIVE_CONNECTIONS";
export const LIVE_TOOLS_VARIABLE = "GRAFT_STOCK_TOOLS";

/** A connection a live run calls the vendor over: the scheme, its parameters and the credential's fields. */
export type LiveConnection = {
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  credential: Record<string, string>;
  /** Overrides the starter's primary host, for a vendor whose test account answers elsewhere. */
  primaryHost?: string;
};

export type StockHarnessMode =
  | { kind: "replay"; tools: string[] | null }
  | { kind: "live"; tools: string[] | null; connections: Record<string, LiveConnection> };

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * The mode the environment asks for, or a sentence saying what is wrong with it. `GRAFT_STOCK_TOOLS`
 * (comma-separated wire names) narrows either mode to those tools; a keyless vendor (a starter on
 * `none`) needs no entry in `GRAFT_STOCK_LIVE_CONNECTIONS`, which is keyed by vendor slug.
 */
export function stockHarnessModeFrom(
  env: Readonly<Record<string, string | undefined>>,
): StockHarnessMode | { error: string } {
  const listed = env[LIVE_TOOLS_VARIABLE]
    ?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const tools = listed && listed.length > 0 ? listed : null;
  const live = env[LIVE_VARIABLE];
  if (live === undefined || live === "" || live === "0") return { kind: "replay", tools };
  if (live !== "1") return { error: `${LIVE_VARIABLE} is 1 or unset, not ${JSON.stringify(live)}` };
  const read = liveConnectionsFrom(env);
  if (!read.ok) return { error: read.error };
  return { kind: "live", tools, connections: read.connections };
}

/**
 * A maintainer's connections, keyed by vendor slug, off `GRAFT_STOCK_LIVE_CONNECTIONS`: what the
 * live harness and the build command (GRA-246) call a keyed vendor over. Unset is none; a malformed
 * value is a sentence that never repeats it, since it holds credentials.
 */
export function liveConnectionsFrom(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; connections: Record<string, LiveConnection> } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const raw = env[LIVE_CONNECTIONS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return { ok: true, connections: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The value is a secret: the sentence never repeats it.
    return fail(`${LIVE_CONNECTIONS_VARIABLE} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(`${LIVE_CONNECTIONS_VARIABLE} must be an object keyed by vendor`);
  }
  const connections: Record<string, LiveConnection> = {};
  for (const [vendor, entry] of Object.entries(parsed)) {
    const where = `${LIVE_CONNECTIONS_VARIABLE}.${vendor}`;
    if (typeof entry !== "object" || entry === null) return fail(`${where} must be an object`);
    const { scheme, schemeConfig, credential, primaryHost } = entry as Record<string, unknown>;
    if (typeof scheme !== "string" || !isAuthScheme(scheme)) {
      return fail(`${where}.scheme must be one of the proxy's schemes`);
    }
    if (schemeConfig !== undefined && !isStringRecord(schemeConfig)) {
      return fail(`${where}.schemeConfig must map names to strings`);
    }
    if (!isStringRecord(credential)) {
      return fail(`${where}.credential must map the scheme's fields to strings`);
    }
    if (
      primaryHost !== undefined &&
      (typeof primaryHost !== "string" || !isHttpsUrl(primaryHost))
    ) {
      return fail(`${where}.primaryHost must be a URL`);
    }
    connections[vendor] = {
      scheme,
      schemeConfig: schemeConfig ?? {},
      credential,
      ...(primaryHost ? { primaryHost } : {}),
    };
  }
  return { ok: true, connections };
}

/** Whether a value parses as an `https:` URL, so the harness never meets one it cannot read. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
