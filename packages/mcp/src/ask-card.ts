import type { AskCard, AskCardTool } from "@graft/ask-card/shape";
import { type ConnectionOutput, takesCredential } from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { ConnectionScheme } from "@graft/db/schema/connection";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

import type {
  ConnectionProposalPayload,
  CredentialAskPayload,
  ScopeAskPayload,
} from "./connection-request";

/**
 * The **ask card** (GRA-84; ADR 0006 as amended 2026-09-18): the MCP App a chat product renders
 * in place of a handoff link, for the tools that can ask. Three pieces meet here. The one
 * **resource** the server lists, `ui://graft/ask`, whose body is `@graft/ask-card`'s built page
 * (`session.ts` serves it). The **tool metadata** that makes a host fetch and render it —
 * `_meta.ui.resourceUri` on every tool that can ask — `acquire`, `request_connection`,
 * `request_credential`, and since GRA-116 `run_tool`, each `execute__<connection id>` and each
 * authored tool in the list, whose first write answers the tool ask — declared unconditionally
 * because Claude.ai renders apps without declaring the extension in `initialize` (the ticket's
 * research), and on no other tool; a host mounts the page for every result of such a tool, and the
 * page draws nothing for a result that is not an ask. And the **card data** an awaiting result carries
 * under `structuredContent.card`, built by the two ask flows (`approval.ts`,
 * `connection-request.ts`) from the same rows the console's handoff page reads: the agent's name,
 * the vendor, the connection and its hosts, the scheme and whether it takes a credential, the
 * documentation link, the expiry, the handoff URL — never a secret, since none is on the row
 * either — and `answerable`, the server's word on whether the card may answer in place.
 *
 * `answerable` is the amendment's scope as one boolean: true for the build approval, for a tool's
 * first-use approval (GRA-116), for a connection proposal whose scheme takes no credential and
 * whose provider connects through the form, and for the scope ask — a yes or no on a connection
 * the person already made (GRA-104); false for everything else — a scheme with a secret, a
 * credential re-entry, a link provider's ask — where the card has nothing it may record itself.
 * What it does instead (GRA-117, GRA-118): opens the console page, or the provider's link
 * `tools/start-link.ts` mints, in the person's browser with `from=card`, and polls
 * `tools/ask-status.ts` until the ask is settled elsewhere. `tools/answer-ask.ts` applies the
 * same predicate again before recording anything: the card is the person's, but its word is not
 * trusted over the row's.
 *
 * The resource's `_meta.ui.csp` is declared **empty** (GRA-112): the card reaches Graft through
 * the host's own bridge (`tools/call` over `postMessage`) and fetches nothing from any origin, so
 * there is no domain to allow — and saying so outright, rather than leaving the field for the
 * host's default, is what ChatGPT's troubleshooting entry for "structured content only, no
 * component" asks a server to confirm (the GRA-84 research of 2026-09-19). Beside every MCP Apps
 * key sits ChatGPT's documented compatibility alias — `openai/outputTemplate` on the tool,
 * `openai/widgetCSP`, `openai/widgetPrefersBorder` and `openai/widgetDescription` on the resource
 * — belt and braces for a host that reads the alias first; ext-apps' own `registerAppTool` writes
 * none, so nothing here depends on them. GRA-55's result shape is kept for a host that renders
 * nothing: `content`'s text, `url`, `message` and `reason` are what they were, and `card` sits
 * beside them in `structuredContent` alone (`result.ts`'s `withCard`), so such a host shows
 * exactly the sentence and link it showed before. For a client the server knows renders the card
 * (`card-client.ts`, GRA-120), `message` takes its card form and `cardShown: true` rides beside
 * `url`, so the model says the person answers on the card rather than relaying the link a second
 * time; `url` itself never changes. What did move for every client is `isError`: an awaiting result
 * is a result (`result.ts`'s `toolAwaiting`), because neither host mounts a view for an error
 * result (ext-apps issue 694) — the card GRA-84 shipped could not render on either host until then.
 */

export const ASK_CARD_RESOURCE_URI = "ui://graft/ask";

/** The MIME type the MCP Apps extension names for an app's page; both hosts key on it. */
export const ASK_CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** One sentence on what the page shows, for ChatGPT's `openai/widgetDescription` (the header). */
const ASK_CARD_WIDGET_DESCRIPTION =
  "Graft's ask card: a build approval, a keyless connection confirmation or a scope ask answered in place, or a link to the console.";

export const ASK_CARD_RESOURCE: Resource = {
  uri: ASK_CARD_RESOURCE_URI,
  name: "graft-ask",
  title: "Graft ask card",
  description:
    "The card Graft shows for an ask a tool answers with: a build approval, a connection confirmation or a scope ask the person answers in place, or the link to answer it in the console.",
  mimeType: ASK_CARD_MIME_TYPE,
  // The extension's keys, then ChatGPT's aliases of each (the header): an empty CSP because the
  // card fetches nothing, and a border, since the card is a form and not a figure.
  _meta: {
    ui: {
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: true,
    },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": ASK_CARD_WIDGET_DESCRIPTION,
  },
};

/**
 * On a tool definition: render `ui://graft/ask` for this tool's results. Exactly three tools carry
 * it (`tools/meta.ts`). `openai/outputTemplate` is ChatGPT's documented alias of `ui.resourceUri`,
 * same value (the header).
 */
export const ASK_CARD_TOOL_META: NonNullable<Tool["_meta"]> = {
  ui: { resourceUri: ASK_CARD_RESOURCE_URI },
  "openai/outputTemplate": ASK_CARD_RESOURCE_URI,
};

/**
 * On a tool definition: callable from the card's frame and left out of the model's list by the
 * host (the extension's `visibility`). The host hides it; Graft cannot, and does not rely on it
 * — `tools/answer-ask.ts` guards the call on its own terms.
 */
export const APP_ONLY_TOOL_META: NonNullable<Tool["_meta"]> = {
  ui: { visibility: ["app"] },
};

/**
 * The extension's id in a client's `initialize` capabilities. A client that declares it has
 * implemented the MCP Apps specification, whose host requirements include leaving an `app`-only
 * tool out of the model's list — the second of `answer_ask`'s two admission signals.
 */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * The chat products known to render the card and hide its tool, by the host their OAuth callback
 * answers on — the first admission signal. Claude's is `claude.ai/api/mcp/auth_callback`,
 * ChatGPT's `chatgpt.com/connector_platform_oauth_redirect` (the GRA-84 research). The
 * deployment's list is `GRAFT_CARD_HOSTS` (`packages/env/src/schema.ts`, the same default), on
 * `McpDeps.cardHosts`; this is the fallback for a `McpDeps` built without one.
 */
export const DEFAULT_CARD_HOSTS: readonly string[] = ["claude.ai", "chatgpt.com"];

/**
 * Whether every registered redirect URI of an OAuth client is on a card host — its hostname equal
 * to, or a subdomain of, an entry. Every URI, because a client that could be sent back to one
 * off-list host is not the product the list names; an empty list, or a URI that does not parse,
 * admits nobody. Hostnames compare lower-case, as `GRAFT_CARD_HOSTS` is parsed.
 */
export function redirectsOnCardHosts(
  redirectUris: readonly string[],
  cardHosts: readonly string[],
): boolean {
  if (redirectUris.length === 0) return false;
  const hosts = cardHosts.map((host) => host.toLowerCase());
  return redirectUris.every((uri) => {
    let hostname: string;
    try {
      hostname = new URL(uri).hostname.toLowerCase();
    } catch {
      return false;
    }
    return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  });
}

/**
 * The card for a `build` or `tool` ask (`approval.ts`): the connection's facts, and for a tool's
 * first use (GRA-116) the tool's — its wire name, its description in the model's words, its two
 * hints and whether it is set to ask every time. Both are answerable: a yes or no on facts the
 * person can read, with nothing to enter (ADR 0006 as amended 2026-09-19).
 */
export function approvalAskCard(
  args: {
    action: PendingActionRow;
    agentName: string;
    connection: ConnectionOutput;
    url: string;
  } & ({ kind: "build" } | { kind: "tool"; toolName: string; tool: AskCardTool }),
): AskCard {
  const { action, connection } = args;
  return {
    pendingActionId: action.id,
    kind: args.kind,
    agentName: args.agentName,
    vendor: connection.vendor,
    displayName: connection.displayName,
    primaryHost: connection.primaryHost,
    hosts: connection.hosts,
    scheme: connection.scheme,
    takesCredential: takesCredential(connection.scheme),
    docsUrl: null,
    expiresAt: action.expiresAt.toISOString(),
    url: args.url,
    answerable: true,
    ...(connection.provider !== "keyring" ? { provider: connection.provider } : {}),
    ...(args.kind === "tool" ? { toolName: args.toolName, tool: args.tool } : {}),
  };
}

/**
 * Whether a `connection` ask may be answered from the card: the keyring's form (or an ask made
 * before providers existed, which is the keyring's), for a scheme with nothing to enter. A scheme
 * with a secret is a form on the console, which the card opens as a popup (GRA-118); a link
 * provider's ask is started from the card through `start_link` and answered by the link's return
 * (GRA-117) — the card may decline it, and nothing else.
 */
export function connectionAskAnswerable(
  payload: Pick<ConnectionProposalPayload, "providerConnect" | "scheme">,
): boolean {
  const connect = payload.providerConnect ?? "form";
  return connect === "form" && !takesCredential(payload.scheme as ConnectionScheme);
}

/** The card for a `connection` ask (`connection-request.ts`): the proposal as the agent made it. */
export function connectionAskCard(args: {
  action: PendingActionRow;
  agentName: string;
  payload: ConnectionProposalPayload;
  url: string;
}): AskCard {
  const { action, payload } = args;
  const providerConnect = payload.providerConnect === "link" ? "link" : "form";
  return {
    pendingActionId: action.id,
    kind: "connection",
    agentName: args.agentName,
    vendor: payload.vendor,
    displayName: payload.displayName,
    primaryHost: payload.primaryHost,
    hosts: payload.hosts,
    scheme: payload.scheme,
    takesCredential: takesCredential(payload.scheme as ConnectionScheme),
    docsUrl: payload.docsUrl,
    expiresAt: action.expiresAt.toISOString(),
    url: args.url,
    answerable: connectionAskAnswerable(payload),
    provider: payload.provider,
    providerConnect,
  };
}

/**
 * The card for a `scope` ask (GRA-104): the connection the person already holds, as the console's
 * card shows it, answerable — the answer is a yes or no on a row the person made, with GRA-75's
 * build choice, and nothing is entered.
 */
export function scopeAskCard(args: {
  action: PendingActionRow;
  agentName: string;
  payload: ScopeAskPayload;
  url: string;
}): AskCard {
  const { action, payload } = args;
  return {
    pendingActionId: action.id,
    kind: "scope",
    agentName: args.agentName,
    vendor: payload.vendor,
    displayName: payload.displayName,
    primaryHost: payload.primaryHost,
    hosts: payload.hosts,
    scheme: payload.scheme,
    takesCredential: takesCredential(payload.scheme as ConnectionScheme),
    docsUrl: payload.docsUrl,
    expiresAt: action.expiresAt.toISOString(),
    url: args.url,
    answerable: true,
    ...(payload.provider !== "keyring" ? { provider: payload.provider } : {}),
  };
}

/** The card for a `credential` ask: the connection named, never answerable — the secret is the console's. */
export function credentialAskCard(args: {
  action: PendingActionRow;
  agentName: string;
  payload: CredentialAskPayload;
  url: string;
}): AskCard {
  const { action, payload } = args;
  return {
    pendingActionId: action.id,
    kind: "credential",
    agentName: args.agentName,
    vendor: payload.vendor,
    displayName: payload.connectionName,
    primaryHost: null,
    hosts: payload.hosts,
    scheme: payload.scheme,
    takesCredential: takesCredential(payload.scheme as ConnectionScheme),
    docsUrl: null,
    expiresAt: action.expiresAt.toISOString(),
    url: args.url,
    answerable: false,
  };
}
