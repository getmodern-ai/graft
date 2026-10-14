import { describe, expect, it } from "vitest";

import { type PendingAction, readAsk } from "./pending-action-queries";
import {
  EXPIRY_SHOWN_WITHIN_MS,
  requestRowAnswer,
  requestRowCopy,
  requestRowWhen,
  toolActionWords,
} from "./request-row";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function action(kind: string, payload: Record<string, unknown>): PendingAction {
  return {
    id: "pa_1",
    agentId: "agt_1",
    agent: { id: "agt_1", name: "Codex", clientName: null },
    kind,
    payload,
    expiresAt: "2026-10-15T12:00:00.000Z",
    createdAt: "2026-10-14T11:58:00.000Z",
    answeredAt: null,
    answer: null,
    consumedAt: null,
    url: "https://console.example/pending/pa_1?t=h",
  };
}

const copyOf = (kind: string, payload: Record<string, unknown>) =>
  requestRowCopy(readAsk(action(kind, payload)));

const tool = (overrides: Record<string, unknown> = {}) => ({
  toolId: "tool_1",
  toolName: "gmail__send_email",
  vendor: "gmail",
  description: "Sends an email.",
  annotations: { readOnlyHint: false, destructiveHint: false },
  connectionId: "con_1",
  connectionName: "Gmail",
  integrationName: "Gmail",
  hosts: ["gmail.googleapis.com"],
  note: "",
  askEveryCall: false,
  ...overrides,
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  provider: "keyring",
  providerConnect: "form",
  vendor: "notion",
  displayName: "Notion",
  scheme: "bearer",
  schemeConfig: {},
  primaryHost: "https://api.notion.com",
  hosts: ["api.notion.com"],
  docsUrl: null,
  note: "",
  ...overrides,
});

const keyless = (overrides: Record<string, unknown> = {}) =>
  proposal({
    vendor: "open-meteo",
    displayName: "Open-Meteo",
    scheme: "none",
    primaryHost: "https://api.open-meteo.com",
    hosts: ["api.open-meteo.com"],
    ...overrides,
  });

describe("requestRowCopy", () => {
  it("reads a tool ask as what the tool does, with Deny and an Allow that opens the how-much menu", () => {
    expect(copyOf("tool", tool())).toEqual({
      variant: "tool",
      vendor: "gmail",
      integrationName: "Gmail",
      title: "Codex wants to send email in Gmail",
      destructive: false,
      detail: null,
      decline: "Deny",
      primary: { label: "Allow", does: "menu" },
    });
  });

  it("chips a destructive tool and names the account when it is not the integration's name", () => {
    const copy = copyOf(
      "tool",
      tool({
        toolName: "hubspot__delete-contacts",
        vendor: "hubspot",
        integrationName: "HubSpot",
        connectionName: "seb@getmodern.ai",
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    );
    expect(copy.title).toBe("Codex wants to delete contacts in HubSpot");
    expect(copy.destructive).toBe(true);
    expect(copy.detail).toBe("As seb@getmodern.ai");
  });

  it("answers a build ask on the spot", () => {
    const copy = copyOf("build", {
      connectionId: "con_1",
      vendor: "hubspot",
      connectionName: "HubSpot",
      hosts: ["api.hubapi.com"],
    });
    expect(copy).toMatchObject({
      variant: "build",
      title: "Codex wants to build its own HubSpot tools",
      detail: "Anything it builds still asks before changing data",
      decline: "Decline",
      primary: { label: "Allow", does: "answer" },
    });
  });

  it("opens the form for a connection that needs a key, or a sign-in for OAuth", () => {
    expect(copyOf("connection", proposal())).toMatchObject({
      variant: "connection-form",
      title: "Codex wants to connect Notion",
      detail: "Needs your Notion key",
      primary: { label: "Connect", does: "open" },
    });
    expect(copyOf("connection", proposal({ scheme: "oauth_authorization_code" })).detail).toBe(
      "Needs you to sign in to Notion",
    );
  });

  it("opens a link provider's ask, naming the provider", () => {
    expect(
      copyOf("connection", proposal({ provider: "pipedream", providerConnect: "link" })),
    ).toMatchObject({
      variant: "connection-link",
      detail: "Sign in through Pipedream",
      primary: { label: "Connect", does: "open" },
    });
  });

  it("confirms a keyless connection on the spot", () => {
    expect(copyOf("connection", keyless())).toMatchObject({
      variant: "connection-keyless",
      title: "Codex wants to connect Open-Meteo",
      detail: "A public API, no key needed",
      primary: { label: "Confirm", does: "confirm" },
    });
  });

  it("confirms a keyless widening, naming the hosts it adds", () => {
    const copy = copyOf(
      "connection",
      keyless({
        hosts: [
          "api.open-meteo.com",
          "air-quality-api.open-meteo.com",
          "geocoding-api.open-meteo.com",
        ],
        widens: {
          connectionId: "con_1",
          addedHosts: ["air-quality-api.open-meteo.com", "geocoding-api.open-meteo.com"],
        },
      }),
    );
    expect(copy).toMatchObject({
      variant: "connection-widen",
      title: "Codex wants to reach more of Open-Meteo",
      detail: "Adds air-quality-api.open-meteo.com and 1 more",
      primary: { label: "Confirm", does: "confirm" },
    });
  });

  it("says a link provider stepped aside, and opens the form it fell back to", () => {
    expect(
      copyOf(
        "connection",
        proposal({ providerFallback: { from: "pipedream", at: "2026-10-14T11:00:00.000Z" } }),
      ),
    ).toMatchObject({
      variant: "connection-fallback",
      detail: "Pipedream couldn't start its sign-in, so connect it here",
      primary: { label: "Connect", does: "open" },
    });
  });

  it("asks for a credential again by what happened to it", () => {
    const credential = (overrides: Record<string, unknown>) =>
      copyOf("credential", {
        connectionId: "con_1",
        vendor: "notion",
        connectionName: "Notion",
        scheme: "bearer",
        hosts: ["api.notion.com"],
        reason: null,
        revoked: false,
        ...overrides,
      });
    expect(credential({})).toMatchObject({
      variant: "credential",
      title: "Codex needs a new key for Notion",
      detail: "Notion stopped accepting what Graft holds",
      primary: { label: "Update key", does: "open" },
    });
    expect(credential({ reason: "401 unauthorized" }).detail).toBe("401 unauthorized");
    expect(credential({ revoked: true })).toMatchObject({
      title: "Codex wants to reconnect Notion",
      detail: "Its tools can't run until you reconnect",
      primary: { label: "Reconnect" },
    });
    expect(credential({ scheme: "oauth_authorization_code" })).toMatchObject({
      title: "Codex needs you to sign in to Notion again",
      primary: { label: "Sign in" },
    });
    expect(credential({ reason: "x".repeat(300) }).detail).toHaveLength(120);
  });

  it("answers a scope ask on the spot", () => {
    expect(
      copyOf("scope", {
        connectionId: "con_1",
        vendor: "google-drive",
        displayName: "Google Drive",
        provider: "keyring",
        primaryHost: "https://www.googleapis.com",
        hosts: ["www.googleapis.com"],
        scheme: "bearer",
        docsUrl: null,
      }),
    ).toMatchObject({
      variant: "scope",
      title: "Codex wants to use Google Drive",
      detail: "You've already connected it",
      primary: { label: "Allow", does: "answer" },
    });
  });

  it("draws an ask it cannot read, and opens it", () => {
    expect(copyOf("telepathy", { vendor: "slack" })).toMatchObject({
      variant: "other",
      vendor: "slack",
      title: "Codex is waiting on an answer",
      decline: "Decline",
      primary: { label: "Open", does: "open" },
    });
    // A known kind missing what it promises reads as unknown too.
    expect(copyOf("tool", {}).variant).toBe("other");
  });

  it("names a revoked agent's ask", () => {
    const ask = readAsk({ ...action("tool", tool()), agent: null });
    expect(requestRowCopy(ask).title).toBe("A revoked agent wants to send email in Gmail");
  });
});

describe("toolActionWords", () => {
  it("reads the wire name's own part as words", () => {
    expect(toolActionWords("gmail__send_email")).toBe("send email");
    expect(toolActionWords("google_calendar__delete-event")).toBe("delete event");
    expect(toolActionWords("x__listMessages")).toBe("list messages");
    expect(toolActionWords("x__")).toBeNull();
  });
});

describe("requestRowWhen", () => {
  it("shows the age, then the expiry once it is near", () => {
    expect(requestRowWhen(action("tool", {}), NOW)).toEqual({
      iso: "2026-10-14T11:58:00.000Z",
      label: "2 minutes ago",
    });
    const soon = new Date(NOW.getTime() + EXPIRY_SHOWN_WITHIN_MS - 60 * 60 * 1000).toISOString();
    expect(requestRowWhen({ ...action("tool", {}), expiresAt: soon }, NOW)).toEqual({
      iso: soon,
      label: "expires in 5 hours",
    });
  });
});

describe("requestRowAnswer", () => {
  const answerOf = (kind: string, payload: Record<string, unknown>) =>
    requestRowAnswer(readAsk(action(kind, payload)));

  it("answers build and scope through the answer route, granting nothing the row did not show", () => {
    expect(
      answerOf("build", { connectionId: "c", vendor: "v", connectionName: "V", hosts: [] }),
    ).toEqual({ route: "answer", body: { allow: true } });
    expect(
      answerOf("scope", {
        connectionId: "c",
        vendor: "v",
        displayName: "V",
        provider: "keyring",
        primaryHost: "https://v.example",
        hosts: ["v.example"],
        scheme: "bearer",
        docsUrl: null,
      }),
    ).toEqual({ route: "answer", body: { allow: true, approveBuild: false } });
  });

  it("confirms a keyless proposal as the agent made it, with no grant", () => {
    expect(answerOf("connection", keyless())).toEqual({
      route: "connection",
      body: {
        vendor: "open-meteo",
        displayName: "Open-Meteo",
        scheme: "none",
        schemeConfig: {},
        primaryHost: "https://api.open-meteo.com",
        hosts: ["api.open-meteo.com"],
        credential: {},
        approveBuild: false,
        allowVendor: false,
      },
    });
    expect(
      answerOf(
        "connection",
        keyless({
          hosts: ["api.open-meteo.com", "air-quality-api.open-meteo.com"],
          widens: { connectionId: "con_1", addedHosts: ["air-quality-api.open-meteo.com"] },
        }),
      )?.route,
    ).toBe("connection");
  });

  it("needs the person's input for every other kind", () => {
    expect(answerOf("tool", tool())).toBeNull();
    expect(answerOf("connection", proposal())).toBeNull();
    expect(answerOf("telepathy", {})).toBeNull();
  });
});
