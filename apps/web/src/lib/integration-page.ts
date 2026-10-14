import { takesCredential } from "@graft/core/connection/connection.rules";

import {
  type Connection,
  type ConnectionStatus,
  connectionStatus,
  isGatewayConnection,
  isKeyringConnection,
  type ToolboxTool,
} from "./connection-queries";
import type { Integration } from "./integration-queries";
import { providerLabel } from "./provider-name";
import { CONNECTION_STATUS_CHIP, connectionStateChip, type StatusChip } from "./status-chips";

/**
 * The integration page's decisions (GRA-315; GRA-287 item 1: one page per integration, listing its
 * connections), as pure functions over the integrations read and the connections read. The route
 * and `components/integration/` draw what these answer.
 */

/** The page's tabs, in the order the bar draws them; the open one rides in the URL's search. */
export const INTEGRATION_TABS = ["tools", "agents", "activity", "connection"] as const;
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];
export const DEFAULT_INTEGRATION_TAB: IntegrationTab = "tools";

export const INTEGRATION_TAB_LABELS: Record<IntegrationTab, string> = {
  tools: "Tools",
  agents: "Agents",
  activity: "Activity",
  connection: "Connection",
};

/**
 * The route's search: `tab` when it names a tab other than the default, and nothing otherwise, so
 * a stray or default value never sticks in the URL and `/integrations/gmail` is the Tools tab.
 */
export function readIntegrationSearch(search: Record<string, unknown>): { tab?: IntegrationTab } {
  const tab = search.tab;
  return typeof tab === "string" &&
    tab !== DEFAULT_INTEGRATION_TAB &&
    (INTEGRATION_TABS as readonly string[]).includes(tab)
    ? { tab: tab as IntegrationTab }
    : {};
}

/** A connection where it stands: the server's word for a live one, `revoked` otherwise. */
export type PageConnectionState = ConnectionStatus | "provider_unavailable";
export type PageConnection = Connection & { state: PageConnectionState };

export type IntegrationPage =
  | { kind: "missing" }
  | {
      kind: "integration";
      vendor: string;
      displayName: string;
      /** Live connections oldest first, as the integrations read answers them, then revoked ones newest first. */
      connections: PageConnection[];
      /** False when every connection of the vendor is revoked: the page is read-only. */
      live: boolean;
      chip: StatusChip;
      /** "connected 21 days ago" off the oldest live connection, or "revoked …" off the newest revoke. */
      since: { verb: "connected" | "revoked"; at: string };
      toolCount: number;
      agentCount: number;
    };

const newestRevokedFirst = (a: Connection, b: Connection) =>
  (b.revokedAt ?? "").localeCompare(a.revokedAt ?? "");

/**
 * The page for a vendor slug. A vendor with a live connection is its integrations row, with the
 * vendor's revoked connections listed after the live ones; a vendor whose every connection is
 * revoked has no row (GRA-291) and is drawn from the connections alone, read-only; a vendor the
 * person never connected is `missing`. The tool count off the row counts tools with a current
 * version, and the fallback counts the same way.
 */
export function integrationPageOf(
  vendor: string,
  integrations: readonly Integration[],
  connections: readonly Connection[],
  tools: readonly Pick<ToolboxTool, "vendor" | "currentVersionId">[],
): IntegrationPage {
  const row = integrations.find((integration) => integration.vendor === vendor) ?? null;
  const revoked = connections
    .filter((connection) => connection.vendor === vendor && connection.revokedAt !== null)
    .sort(newestRevokedFirst)
    .map((connection): PageConnection => ({ ...connection, state: "revoked" }));
  // The two reads refresh apart: a row the connections read already calls revoked is revoked, so
  // a revoke never draws one connection twice while the integrations read catches up.
  // The other way round, a row the integrations read has already dropped is drawn from the
  // connections read as it stands until that read catches up, so the page never reads "missing".
  const revokedIds = new Set(revoked.map((connection) => connection.id));
  const live: PageConnection[] = row
    ? row.connections.filter((connection) => !revokedIds.has(connection.id))
    : connections
        .filter((connection) => connection.vendor === vendor && connection.revokedAt === null)
        .map((connection) => ({ ...connection, state: connectionStatus(connection) }));
  const newestRevoked = revoked[0];
  const oldestLive = live[0];
  const toolCount =
    row?.toolCount ??
    tools.filter((tool) => tool.vendor === vendor && tool.currentVersionId !== null).length;

  if (oldestLive) {
    const attentionId =
      row?.needsAttention?.connectionId ??
      live.find((connection) => connection.state !== "connected")?.id;
    const attention = live.find((connection) => connection.id === attentionId);
    return {
      kind: "integration",
      vendor,
      displayName: row?.displayName ?? oldestLive.displayName,
      connections: [...live, ...revoked],
      live: true,
      chip: attention
        ? connectionStateChip(attention, attention.state)
        : CONNECTION_STATUS_CHIP.connected,
      since: { verb: "connected", at: oldestLive.createdAt },
      toolCount,
      agentCount: row?.agents.length ?? 0,
    };
  }
  if (!newestRevoked) return { kind: "missing" };
  return {
    kind: "integration",
    vendor,
    displayName: newestRevoked.displayName,
    connections: revoked,
    live: false,
    chip: CONNECTION_STATUS_CHIP.revoked,
    since: { verb: "revoked", at: newestRevoked.revokedAt ?? newestRevoked.updatedAt },
    toolCount,
    agentCount: 0,
  };
}

/** The header's last fact: how many of the person's agents can use the integration now. */
export function agentsCanUseLine(agentCount: number): string {
  if (agentCount === 0) return "no agent can use it";
  return `${agentCount} ${agentCount === 1 ? "agent" : "agents"} can use it`;
}

/** Whether the keyring holds this row with no credential at all (GRA-66). */
const isKeyless = (connection: Connection) =>
  isKeyringConnection(connection) && !takesCredential(connection.scheme);

/** "Connected through", in the person's words: where the connection comes from and how it signs in. */
export function connectedThroughLabel(connection: Connection): string {
  if (isGatewayConnection(connection)) return "Your API gateway";
  if (!isKeyringConnection(connection)) return providerLabel(connection.provider);
  if (isKeyless(connection)) return "Graft, with no credential: the integration is public";
  if (connection.oauth) return "Graft, through OAuth";
  return "Graft, with a credential you entered";
}

/** Who holds the login (CONTEXT.md, *Connection*: write-only after entry), and that no agent sees it. */
export function loginHolderLine(connection: Connection): string {
  if (isGatewayConnection(connection)) return "Held by your API gateway. Graft stores nothing.";
  if (!isKeyringConnection(connection)) {
    return `Held by ${providerLabel(connection.provider)}. Graft stores only the account's id.`;
  }
  if (isKeyless(connection)) return "None needed. Calls go through with nothing added.";
  if (connection.revokedAt) return "Cleared when it was revoked.";
  if (connection.credentialSetAt === null) return "Not entered yet.";
  return "Held by Graft. Never shared with agents or tools.";
}

/**
 * The scopes a keyring OAuth connection asks for, from its scheme parameters (ADR 0005), one per
 * entry; empty for every other row, whose provider decides what it asks for.
 */
export function oauthScopesOf(connection: Connection): string[] {
  if (!isKeyringConnection(connection) || connection.oauth === null) return [];
  return (connection.schemeConfig.scopes ?? "").split(/[\s,]+/).filter(Boolean);
}

/** The scheme's parameters other than the scopes, which `oauthScopesOf` lists on their own. */
export function schemeParametersOf(connection: Connection): [string, string][] {
  const scopes = oauthScopesOf(connection).length > 0;
  return Object.entries(connection.schemeConfig).filter(([key]) => !(scopes && key === "scopes"));
}

/**
 * The ways to sign a connection in again, as the connections card offers them (ADR 0005, ADR
 * 0007): a consent where the client secret is in place, the credential dialog otherwise. Only a
 * live keyring row that takes a credential has any; a gateway, a link provider and a keyless row
 * have nothing to enter, and a revoked row is read-only here.
 */
export type ReconnectAction = { kind: "consent" | "credential"; label: string };

export function reconnectActionsOf(
  connection: Connection,
  state: PageConnectionState = connectionStatus(connection),
): ReconnectAction[] {
  if (state === "revoked" || state === "provider_unavailable") return [];
  if (!isKeyringConnection(connection) || isKeyless(connection)) return [];
  if (connection.oauth) {
    if (state === "awaiting_credential") {
      return [{ kind: "credential", label: "Enter client secret" }];
    }
    return [
      { kind: "consent", label: state === "awaiting_consent" ? "Connect" : "Sign in again" },
      { kind: "credential", label: "Re-enter client secret" },
    ];
  }
  return [
    {
      kind: "credential",
      label: state === "awaiting_credential" ? "Enter credential" : "Re-enter credential",
    },
  ];
}
