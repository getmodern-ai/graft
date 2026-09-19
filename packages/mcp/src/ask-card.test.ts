import { readAskCardHtml } from "@graft/ask-card";
import { FROM_CARD, FROM_CARD_PARAM, withFromCard } from "@graft/ask-card/shape";
import {
  FROM_CARD as CORE_FROM_CARD,
  FROM_CARD_PARAM as CORE_FROM_CARD_PARAM,
  openedFromCard,
} from "@graft/core";
import { describe, expect, it } from "vitest";

import {
  APP_ONLY_TOOL_META,
  ASK_CARD_RESOURCE,
  ASK_CARD_RESOURCE_URI,
  ASK_CARD_TOOL_META,
  approvalAskCard,
  connectionAskAnswerable,
  connectionAskCard,
  credentialAskCard,
  scopeAskCard,
} from "./ask-card";
import type { ConnectionProposalPayload } from "./connection-request";
import { createMcpDeps } from "./deps";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";

/**
 * The card's data and the resource's defaults, off the rows (GRA-84): `answerable` is the
 * amendment's scope as one predicate, and the default page reader finds `@graft/ask-card`'s build
 * — which `turbo.json` orders before this suite, and a fresh checkout builds by hand
 * (`pnpm --filter @graft/ask-card build`). The wire behaviour is `session.test.ts` and
 * `answer-ask.test.ts`.
 */

const NOW = new Date("2026-09-18T10:00:00Z");
const action = {
  id: "pa_1",
  agentId: "agent_1",
  kind: "build",
  payload: {},
  connectionId: null,
  expiresAt: new Date(NOW.getTime() + 60_000),
  answeredAt: null,
  answer: null,
  consumedAt: null,
  owner: "person" as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const proposal = (patch: Partial<ConnectionProposalPayload>): ConnectionProposalPayload => ({
  provider: "keyring",
  providerConnect: "form",
  providerTarget: null,
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  scheme: "none",
  schemeConfig: {},
  primaryHost: "https://api.open-meteo.com/v1",
  hosts: ["api.open-meteo.com"],
  docsUrl: "https://open-meteo.com/en/docs",
  note: "",
  ...patch,
});

describe("what the card may answer", () => {
  it("is the keyring's form for a scheme with nothing to enter, and nothing else", () => {
    expect(connectionAskAnswerable(proposal({}))).toBe(true);
    // An ask recorded before providers existed names no connect kind: the keyring's form.
    expect(connectionAskAnswerable({ scheme: "none" })).toBe(true);
    expect(connectionAskAnswerable(proposal({ scheme: "api_key_header" }))).toBe(false);
    expect(connectionAskAnswerable(proposal({ scheme: "bearer" }))).toBe(false);
    expect(connectionAskAnswerable(proposal({ scheme: "oauth_authorization_code" }))).toBe(false);
    expect(
      connectionAskAnswerable(proposal({ providerConnect: "link", provider: "pipedream" })),
    ).toBe(false);
  });

  it("marks a build ask and a tool ask answerable, and a credential ask or a link provider's never", () => {
    const store = createFakeStore();
    const row = store.addConnection({
      id: "conn_1",
      personId: "person_1",
      vendor: "demo",
      displayName: "Demo Orders",
      primaryHost: "https://api.demo.example",
    });
    const connection = {
      ...row,
      oauth: null,
      credentialSetAt: NOW,
    };
    const url = "http://console.graft.test/pending/pa_1?t=x";
    expect(
      approvalAskCard({ action, kind: "build", agentName: "Claude", connection, url }),
    ).toEqual({
      pendingActionId: "pa_1",
      kind: "build",
      agentName: "Claude",
      vendor: "demo",
      displayName: "Demo Orders",
      primaryHost: "https://api.demo.example",
      hosts: ["api.demo.example"],
      scheme: "api_key_header",
      takesCredential: true,
      docsUrl: null,
      expiresAt: action.expiresAt.toISOString(),
      url,
      answerable: true,
    });
    // A tool's first use is answerable since GRA-116, with the tool's facts beside its name.
    const tool = {
      description: "Creates a sales order at Demo.",
      readOnly: false,
      destructive: true,
      askEveryCall: true,
    };
    expect(
      approvalAskCard({
        action: { ...action, kind: "tool" },
        kind: "tool",
        agentName: "Claude",
        connection,
        url,
        toolName: "demo__create-order",
        tool,
      }),
    ).toMatchObject({ kind: "tool", answerable: true, toolName: "demo__create-order", tool });
    expect(
      credentialAskCard({
        action: { ...action, kind: "credential" },
        agentName: "Claude",
        url,
        payload: {
          connectionId: "conn_1",
          vendor: "demo",
          connectionName: "Demo Orders",
          scheme: "api_key_header",
          hosts: ["api.demo.example"],
          reason: "401",
          revoked: false,
        },
      }),
    ).toMatchObject({ kind: "credential", displayName: "Demo Orders", answerable: false });
    expect(
      connectionAskCard({
        action: { ...action, kind: "connection" },
        agentName: "Claude",
        url,
        payload: proposal({ providerConnect: "link", provider: "pipedream" }),
      }),
    ).toMatchObject({ providerConnect: "link", provider: "pipedream", answerable: false });
  });

  it("marks a scope ask answerable, with the row's facts and the provider when it is not the keyring (GRA-104)", () => {
    const url = "http://console.graft.test/pending/pa_1?t=x";
    const payload = {
      connectionId: "conn_gmail",
      vendor: "gmail",
      displayName: "Gmail",
      provider: "pipedream",
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com"],
      scheme: "pipedream_connect_proxy",
      docsUrl: "https://developers.google.com/gmail/api",
    };
    expect(
      scopeAskCard({ action: { ...action, kind: "scope" }, agentName: "Claude", url, payload }),
    ).toEqual({
      pendingActionId: "pa_1",
      kind: "scope",
      agentName: "Claude",
      vendor: "gmail",
      displayName: "Gmail",
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com"],
      scheme: "pipedream_connect_proxy",
      takesCredential: false,
      docsUrl: "https://developers.google.com/gmail/api",
      expiresAt: action.expiresAt.toISOString(),
      url,
      answerable: true,
      provider: "pipedream",
    });
    expect(
      scopeAskCard({
        action: { ...action, kind: "scope" },
        agentName: "Claude",
        url,
        payload: { ...payload, provider: "keyring", scheme: "api_key_header", docsUrl: null },
      }),
    ).not.toHaveProperty("provider");
  });
});

/**
 * `from=card` is written in two import-free places (GRA-117, GRA-118): `@graft/ask-card`'s shape,
 * which the card's bundle reads, and `@graft/core`'s `card.rules.ts`, which the console's routes
 * read. Neither may import the other, so this is where they are held to one another.
 */
describe("the from=card query", () => {
  it("is spelled the same by the card and by the console's rules", () => {
    expect(FROM_CARD_PARAM).toBe(CORE_FROM_CARD_PARAM);
    expect(FROM_CARD).toBe(CORE_FROM_CARD);
    const opened = new URL(withFromCard("http://console.graft.test/pending/pa_1?t=abc"));
    expect(openedFromCard(Object.fromEntries(opened.searchParams))).toBe(true);
    expect(openedFromCard({ t: "abc" })).toBe(false);
  });
});

describe("the resource and the tool metadata", () => {
  it("name one resource with the app MIME type, an empty CSP and ChatGPT's aliases, and the two _meta shapes the extension defines", () => {
    expect(ASK_CARD_RESOURCE).toEqual({
      uri: ASK_CARD_RESOURCE_URI,
      name: "graft-ask",
      title: "Graft ask card",
      description: expect.any(String),
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        "openai/widgetPrefersBorder": true,
        "openai/widgetDescription": expect.stringContaining("Graft's ask card"),
      },
    });
    expect(ASK_CARD_TOOL_META).toEqual({
      ui: { resourceUri: "ui://graft/ask" },
      "openai/outputTemplate": "ui://graft/ask",
    });
    expect(APP_ONLY_TOOL_META).toEqual({ ui: { visibility: ["app"] } });
  });

  it("reads the built page by default: one document with the mount and an inline script", async () => {
    const store = createFakeStore();
    const deps = createMcpDeps({
      ...createFakeDeps(store),
      sandbox: null,
      keys: null,
      proxyPublicUrl: "http://localhost:3000/api/proxy",
      handoff: {
        consoleUrl: "http://console.graft.test",
        secret: "x".repeat(32),
        waitMs: 0,
        ttlMs: 1,
      },
    });
    const html = await (deps.askCardHtml ?? readAskCardHtml)();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('id="ask"');
    expect(html).toContain("<script");
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
  });
});
