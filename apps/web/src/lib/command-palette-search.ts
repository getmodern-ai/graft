import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";

import {
  type ActivityRow,
  activityIntegrationName,
  type IntegrationNames,
} from "./activity-screen";
import type { AgentListItem } from "./agent-queries";
import {
  ACTION_ITEMS,
  filterPalette,
  groupPalette,
  NAVIGATION_ITEMS,
  type PaletteGroup,
  type PaletteItem,
} from "./command-palette";
import type { ToolboxTool } from "./connection-queries";
import { count, formatRelative } from "./format";
import { homeActivityCopy, homeIntegrationNames } from "./home";
import { activityToolLabel } from "./integration-activity";
import type { Integration } from "./integration-queries";
import { agentsPhrase, attentionSentence, inUsePhrase } from "./integrations-list";
import { harnessMark } from "./marks";
import { type PendingAction, readAsk } from "./pending-action-queries";
import { requestAgentName, requestRowCopy, requestRowWhen } from "./request-row";
import type { DirectoryEntry } from "./setup-queries";
import { signInRequestsOf } from "./sign-in-requests";

/**
 * What the command palette finds (GRA-329; Figma 2086:8998, 2086:10233, 2086:11100), as pure
 * functions from the console's cached reads to the palette's rows. Before anything is typed it is
 * the open requests, the screens and the verbs; once something is, every read's rows that answer
 * it, and the directory's integrations the person has not connected beneath them.
 * `components/shell/command-palette.tsx` reads, and draws what `paletteView` answers.
 */

/** The reads the palette is fed from; each absent until it lands, and its rows with it. */
export type PaletteSources = {
  integrations?: readonly Integration[];
  tools?: readonly ToolboxTool[];
  pendingActions?: readonly PendingAction[];
  agents?: readonly AgentListItem[];
  /** The newest page of the person's activity, filtered here rather than by the read. */
  activity?: readonly ActivityRow[];
  /** The directory's answer for the query being typed. */
  directory?: readonly DirectoryEntry[];
  /** How many integrations the directory holds, for "Search all N". */
  directoryTotal?: number;
};

export type PaletteView = {
  groups: PaletteGroup[];
  /** The line above the directory's rows when nothing the person has answers the query. */
  notice: string | null;
};

/** How many open requests *Needs you* lists before "See all N requests". */
export const NEEDS_YOU_SHOWN = 3;

/** How many of the directory's integrations a query shows. */
export const DIRECTORY_SHOWN = 4;

/** The groups fed from the person's own reads, which decide whether the directory takes over. */
const OWN_GROUPS = new Set(["Integrations", "Tools", "Requests", "Activity", "Agents"]);

const integrationMark = (slug: string | null, name: string, logoUrl: string | null = null) =>
  ({ kind: "integration", slug, name, logoUrl }) as const;

function nameOf(vendor: string, names: IntegrationNames): string {
  return integrationNameFor(vendor, names.byVendor.get(vendor) ?? vendor);
}

/**
 * "Connected · 10 tools · 3 in use · used by 3 agents", or the row's attention when it needs the
 * person. The count is every tool the integration offers (GRA-345).
 */
export function integrationDetail(row: Integration): string {
  const attention = attentionSentence(row);
  if (attention) return attention;
  const parts = ["Connected", count(row.toolCount, "tool")];
  const inUse = inUsePhrase(row);
  if (inUse) parts.push(inUse);
  if (row.agents.length > 0) parts.push(`used by ${agentsPhrase(row.agents)}`);
  return parts.join(" · ");
}

export function integrationItems(integrations: readonly Integration[]): PaletteItem[] {
  return integrations.map((row) => ({
    id: `integration:${row.vendor}`,
    group: "Integrations",
    label: row.displayName,
    keywords: [row.vendor, ...row.connections.map((connection) => connection.displayName)],
    detail: integrationDetail(row),
    mark: integrationMark(row.vendor, row.displayName),
    open: { to: "/integrations/$vendor", params: { vendor: row.vendor } },
  }));
}

/**
 * What a tool may do, from its own annotations alone: never what any agent was allowed, since an
 * approval is per agent (ADR 0008), so "asks every time" would be a claim about none of them.
 * "Can delete" is the Tools tab's badge (GRA-287).
 */
export function toolKindLabel(tool: Pick<ToolboxTool, "readOnly" | "destructive">): string {
  if (tool.destructive) return "Can delete";
  return tool.readOnly ? "Read" : "Changes data";
}

/** The toolbox's tools with a version to run; one never published has nothing to open. */
export function toolItems(tools: readonly ToolboxTool[], names: IntegrationNames): PaletteItem[] {
  return tools
    .filter((tool) => tool.currentVersionId !== null)
    .map((tool) => {
      const integration = nameOf(tool.vendor, names);
      return {
        id: `tool:${tool.id}`,
        group: "Tools",
        label: activityToolLabel(`${tool.vendor}__${tool.name}`),
        keywords: [tool.vendor, integration, tool.name],
        detail: `${integration} · ${toolKindLabel(tool)}`,
        mark: integrationMark(tool.vendor, integration),
        open: { to: "/integrations/$vendor", params: { vendor: tool.vendor } },
      };
    });
}

/**
 * The open requests as rows, sign-ins first as Requests lists them (GRA-313), then the asks newest
 * first. An ask opens in place; a sign-in on its integration's Connection tab, where Sign in is.
 */
export function requestItems(
  pendingActions: readonly PendingAction[],
  integrations: readonly Integration[],
  group: "Needs you" | "Requests",
  now: Date,
): PaletteItem[] {
  const signIns: PaletteItem[] = signInRequestsOf(integrations).map((request) => ({
    id: `sign-in:${request.key}`,
    group,
    label: request.title,
    keywords: [request.vendor, request.integrationName, "sign", "signed"],
    detail: request.detail,
    mark: integrationMark(request.vendor, request.integrationName),
    open: {
      to: "/integrations/$vendor",
      params: { vendor: request.vendor },
      search: { tab: "connection" },
    },
  }));
  const asks: PaletteItem[] = pendingActions.map((action) => {
    const copy = requestRowCopy(readAsk(action));
    const when = requestRowWhen(action, now);
    return {
      id: `request:${action.id}`,
      group,
      label: copy.title,
      keywords: [
        requestAgentName(action),
        ...(copy.vendor ? [copy.vendor] : []),
        ...(copy.integrationName ? [copy.integrationName] : []),
      ],
      detail: when ? `Request · ${when.label}` : "Request",
      mark: integrationMark(copy.vendor ?? null, copy.integrationName ?? copy.title),
      open: { request: action.id },
    };
  });
  return [...signIns, ...asks];
}

/** Each row opens the Activity screen filtered to its integration and agent. */
export function activityItems(
  rows: readonly ActivityRow[],
  names: IntegrationNames,
  now: Date,
): PaletteItem[] {
  return rows.map((row) => {
    const integration = activityIntegrationName(row, names);
    return {
      id: `activity:${row.key}`,
      group: "Activity",
      // Home's sentence for the row (GRA-327), so the two never word one run differently.
      label: homeActivityCopy(row, names).title,
      keywords: [row.agent.name, ...(row.vendor ? [row.vendor] : [])],
      detail: formatRelative(row.at, now) || undefined,
      mark: integrationMark(row.vendor, integration ?? row.agent.name),
      open: {
        to: "/activity",
        search: { ...(row.vendor ? { vendor: row.vendor } : {}), agent: row.agent.id },
      },
    };
  });
}

/** Active agents first, then revoked ones, each opening its page; the harness is the sub-line. */
export function agentItems(agents: readonly AgentListItem[]): PaletteItem[] {
  const active = agents.filter((agent) => !agent.revokedAt);
  const revoked = agents.filter((agent) => agent.revokedAt);
  return [...active, ...revoked].map((agent) => ({
    id: `agent:${agent.id}`,
    group: "Agents",
    label: agent.name,
    keywords: agent.connectedVia ? [agent.connectedVia.clientName] : [],
    // The client it connected through, or that none was recorded (GRA-287: no device line).
    detail: agent.revokedAt ? "Revoked" : (agent.connectedVia?.clientName ?? "Not recorded"),
    mark: { kind: "harness", mark: harnessMark(agent.connectedVia?.clientName) },
    tier: agent.revokedAt ? 1 : 0,
    open: { to: "/agents/$agentId", params: { agentId: agent.id } },
  }));
}

/**
 * The directory's integrations the person holds no live connection of, in the directory's own
 * order (ADR 0001 as amended 2026-10-14: no claim beyond the backing's). Connect takes the
 * person to Discover with the integration's name searched, where its card connects it.
 */
export function directoryItems(
  entries: readonly DirectoryEntry[],
  integrations: readonly Integration[],
): PaletteItem[] {
  const connected = new Set(integrations.map((row) => row.vendor));
  return entries
    .filter((entry) => !connected.has(entry.slug))
    .slice(0, DIRECTORY_SHOWN)
    .map((entry) => ({
      id: `directory:${entry.slug}`,
      group: "Connect a new integration",
      label: entry.name,
      keywords: [],
      detail: entry.description ? `Not connected · ${entry.description}` : "Not connected",
      mark: integrationMark(entry.slug, entry.name, entry.logoUrl),
      hint: "Connect",
      open: { to: "/integrations", search: { tab: "discover", q: entry.name } },
    }));
}

/** "Search all N", then Flow C (GRA-323) with what was typed as the name or the docs link. */
export function cantFindItems(query: string, directoryTotal: number | undefined): PaletteItem[] {
  const text = query.trim();
  return [
    {
      id: "directory:search-all",
      group: "Can't find it?",
      // "Search all 1 integration" says nothing a person can use, so a directory of one (the open
      // form's starters can be that few) or of a size not yet read is just the directory.
      label:
        directoryTotal && directoryTotal > 1
          ? `Search all ${directoryTotal.toLocaleString("en")} integrations for “${text}”`
          : `Search the directory for “${text}”`,
      keywords: [],
      mark: { kind: "icon", icon: "search" },
      open: { to: "/integrations", search: { tab: "discover", q: text } },
    },
    {
      id: "directory:custom",
      group: "Can't find it?",
      label: "Connect any API from a link to its docs",
      keywords: [],
      mark: { kind: "icon", icon: "docs" },
      open: { to: "/integrations", search: { tab: "discover", custom: text } },
    },
  ];
}

/**
 * The palette for a query. Blank: *Needs you* (the first `NEEDS_YOU_SHOWN` open requests and "See
 * all N requests" past them), *Go to* and *Do something*. Typed: every read's rows that answer
 * it, ranked and capped by `filterPalette`, then the directory's unconnected integrations; when
 * nothing of the person's answers, *Can't find it?*, and when nothing at all does, a notice too.
 */
export function paletteView(
  sources: PaletteSources,
  query: string,
  now: Date = new Date(),
): PaletteView {
  const integrations = sources.integrations ?? [];
  const names = homeIntegrationNames(integrations);
  const text = query.trim();

  if (text === "") {
    const requests = requestItems(sources.pendingActions ?? [], integrations, "Needs you", now);
    const needsYou = requests.slice(0, NEEDS_YOU_SHOWN);
    if (requests.length > needsYou.length) {
      needsYou.push({
        id: "needs-you:all",
        group: "Needs you",
        label: `See all ${requests.length} requests`,
        keywords: [],
        mark: { kind: "icon", icon: "more" },
        open: { to: "/pending" },
      });
    }
    return {
      groups: groupPalette([...needsYou, ...NAVIGATION_ITEMS, ...ACTION_ITEMS]),
      notice: null,
    };
  }

  const groups = filterPalette(
    [
      ...integrationItems(integrations),
      ...toolItems(sources.tools ?? [], names),
      ...requestItems(sources.pendingActions ?? [], integrations, "Requests", now),
      ...activityItems(sources.activity ?? [], names, now),
      ...agentItems(sources.agents ?? []),
      ...NAVIGATION_ITEMS,
      ...ACTION_ITEMS,
    ],
    text,
  );
  const ownFound = groups.some((group) => OWN_GROUPS.has(group.name));
  const directory = groupPalette([
    ...directoryItems(sources.directory ?? [], integrations),
    ...(ownFound ? [] : cantFindItems(text, sources.directoryTotal)),
  ]);
  return {
    groups: [...groups, ...directory],
    // Not over a screen or a verb the query found ("settings"): the line is about the person's own.
    notice: groups.length === 0 ? `Nothing you've connected matches “${text}”.` : null,
  };
}
