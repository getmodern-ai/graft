import type { AskCard } from "@graft/ask-card/shape";
import { type ConnectionOutput, takesCredential } from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { ConnectionScheme } from "@graft/db/schema/connection";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectionProposalPayload, CredentialAskPayload } from "./connection-request";

/**
 * The **ask card** (GRA-84; ADR 0006 as amended 2026-09-18): the MCP App a chat product renders
 * in place of a handoff link, for the tools that can ask. Three pieces meet here. The one
 * **resource** the server lists, `ui://graft/ask`, whose body is `@graft/ask-card`'s built page
 * (`session.ts` serves it). The **tool metadata** that makes a host fetch and render it —
 * `_meta.ui.resourceUri` on `acquire`, `request_connection` and `request_credential`, declared
 * unconditionally because Claude.ai renders apps without declaring the extension in `initialize`
 * (the ticket's research), and on no other tool. And the **card data** an awaiting result carries
 * under `structuredContent.card`, built by the two ask flows (`approval.ts`,
 * `connection-request.ts`) from the same rows the console's handoff page reads: the agent's name,
 * the vendor, the connection and its hosts, the scheme and whether it takes a credential, the
 * documentation link, the expiry, the handoff URL — never a secret, since none is on the row
 * either — and `answerable`, the server's word on whether the card may answer in place.
 *
 * `answerable` is the amendment's scope as one boolean: true for the build approval and for a
 * connection proposal whose scheme takes no credential and whose provider connects through the
 * form; false for everything else — a scheme with a secret, a link provider's ask, a credential
 * re-entry, a tool's first use — where the card shows the console button and nothing it could
 * click. `tools/answer-ask.ts` applies the same predicate again before recording anything: the
 * card is the person's, but its word is not trusted over the row's.
 *
 * No `_meta.ui.csp` on the resource, on purpose: the card reaches Graft through the host's own
 * bridge (`tools/call` over `postMessage`) and fetches nothing from any origin, so there is no
 * domain to allow. GRA-55's result shape is untouched: `content`'s text, `url`, `message` and
 * `reason` are what they were, and `card` sits beside them in `structuredContent` alone
 * (`result.ts`'s `withCard`), so a host that renders nothing shows exactly the sentence and link
 * it showed before.
 */

export const ASK_CARD_RESOURCE_URI = "ui://graft/ask";

/** The MIME type the MCP Apps extension names for an app's page; both hosts key on it. */
export const ASK_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const ASK_CARD_RESOURCE: Resource = {
  uri: ASK_CARD_RESOURCE_URI,
  name: "graft-ask",
  title: "Graft ask card",
  description:
    "The card Graft shows for an ask a tool answers with: a build approval or a connection confirmation the person answers in place, or the link to answer it in the console.",
  mimeType: ASK_CARD_MIME_TYPE,
};

/** On a tool definition: render `ui://graft/ask` for this tool's results. Exactly three tools carry it (`tools/meta.ts`). */
export const ASK_CARD_TOOL_META: NonNullable<Tool["_meta"]> = {
  ui: { resourceUri: ASK_CARD_RESOURCE_URI },
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

/** The card for a `build` or `tool` ask (`approval.ts`): the connection's facts, answerable only as a build approval. */
export function approvalAskCard(args: {
  action: PendingActionRow;
  kind: "build" | "tool";
  agentName: string;
  connection: ConnectionOutput;
  url: string;
  toolName?: string;
}): AskCard {
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
    answerable: args.kind === "build",
    ...(connection.provider !== "keyring" ? { provider: connection.provider } : {}),
    ...(args.toolName ? { toolName: args.toolName } : {}),
  };
}

/**
 * Whether a `connection` ask may be answered from the card: the keyring's form (or an ask made
 * before providers existed, which is the keyring's), for a scheme with nothing to enter. A link
 * provider's ask is a button on the console; a scheme with a secret is a form there.
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
