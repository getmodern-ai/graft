import { readAskCardHtml } from "@graft/ask-card";
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

  it("marks a build ask answerable, and a tool's or a credential ask never", () => {
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
    expect(
      approvalAskCard({
        action: { ...action, kind: "tool" },
        kind: "tool",
        agentName: "Claude",
        connection,
        url,
        toolName: "demo__create-order",
      }),
    ).toMatchObject({ kind: "tool", answerable: false, toolName: "demo__create-order" });
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
});

describe("the resource and the tool metadata", () => {
  it("name one resource with the app MIME type and no CSP, and the two _meta shapes the extension defines", () => {
    expect(ASK_CARD_RESOURCE).toEqual({
      uri: ASK_CARD_RESOURCE_URI,
      name: "graft-ask",
      title: "Graft ask card",
      description: expect.any(String),
      mimeType: "text/html;profile=mcp-app",
    });
    expect(ASK_CARD_TOOL_META).toEqual({ ui: { resourceUri: "ui://graft/ask" } });
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
