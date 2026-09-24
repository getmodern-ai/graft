import type { SetupCard } from "@graft/ask-card/shape";
import { SETUP_AGENT_PARAM, SETUP_PATH } from "@graft/core";
import { createScriptedModel } from "@graft/model";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASK_CARD_TOOL_META } from "./ask-card";
import type { McpDeps } from "./deps";
import { setupOfferMessage } from "./handoff-message";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { ANSWER_ASK } from "./tools/answer-ask";

/**
 * `find_tool`'s offer of Setup (GRA-210; `setup-offer.ts`), driven as a harness drives it: the
 * SDK's client over the in-memory pair, the real services over the in-memory fakes, no sandbox and
 * no vendor. One person with no connection and three agents: `claude`, minted by a consent from a
 * client registered on `claude.ai`, so the server knows it renders the card; `hermes`, a
 * static-token agent whose harness renders none; and `unknown`, an OAuth agent whose client
 * nothing vouches for. A second person holds a connection of their own, which must not end the
 * first person's offer.
 */

const PERSON = "person_1";
const OTHER_PERSON = "person_2";
const CLAUDE = "agent_claude";
const HERMES = "agent_hermes";
const UNKNOWN = "agent_unknown";
const TOKEN_CLAUDE = "grft_setup_offer_claude_00000000000000000000000";
const TOKEN_HERMES = "grft_setup_offer_hermes_00000000000000000000000";
const TOKEN_UNKNOWN = "grft_setup_offer_unknown_0000000000000000000000";
const CONSOLE_URL = "http://console.graft.test";

const KEYLESS = {
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.com/v1",
  scheme: "none",
  docsUrl: "https://open-meteo.com/en/docs",
};

let store: FakeStore;
let deps: McpDeps;

beforeEach(() => {
  store = createFakeStore({ now: () => new Date("2026-09-23T10:00:00Z") });
  store.addMcpClient({
    id: "client_claude",
    name: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  store.addMcpClient({
    id: "client_unknown",
    name: "Some Client",
    redirectUris: ["https://evil.example/cb"],
  });
  store.addAgent({
    scopeMode: "all",
    id: CLAUDE,
    personId: PERSON,
    token: TOKEN_CLAUDE,
    name: "Claude",
    connectedVia: { clientId: "client_claude", clientName: "Claude" },
  });
  store.addAgent({
    scopeMode: "all",
    id: HERMES,
    personId: PERSON,
    token: TOKEN_HERMES,
    name: "laptop Hermes",
  });
  store.addAgent({
    scopeMode: "all",
    id: UNKNOWN,
    personId: PERSON,
    token: TOKEN_UNKNOWN,
    name: "Some Client",
    connectedVia: { clientId: "client_unknown", clientName: "Some Client" },
  });
  // Another person's connection: counted for them, never for PERSON.
  store.addConnection({
    id: "conn_other",
    personId: OTHER_PERSON,
    vendor: "demo",
    primaryHost: "https://api.demo.example",
  });
  deps = {
    ...createFakeDeps(store),
    sandbox: null,
    keys: null,
    proxyPublicUrl: "http://localhost:3000/api/proxy",
    checkModule: async (input) => ({
      entry: input.entry,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
      contextMembersUsed: [],
      blobReadFields: [],
    }),
    runnerFiles: async () => [],
    skills: async () => [],
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    askCardHtml: async () => "<!doctype html>",
    model: createScriptedModel([]),
    handoff: {
      consoleUrl: CONSOLE_URL,
      secret: "graft-setup-offer-test-handoff-secret-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
      pollMs: 10,
    },
  };
});

const sessions: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((close) => close()));
});

async function connect(token: string) {
  const notifier = createToolListChangedNotifier({ windowMs: 50 });
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "chat-product", version: "0.0.0" });
  await client.connect(clientTransport);
  sessions.push(async () => {
    await client.close();
    await session.close();
    notifier.close();
  });
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    findTool: async () =>
      (await client.callTool({
        name: "find_tool",
        arguments: { query: "weather" },
      })) as CallToolResult,
  };
}

/** The text block the model reads, parsed. */
function text(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

const setupUrlOf = (agentId: string) =>
  `${CONSOLE_URL}${SETUP_PATH}?${SETUP_AGENT_PARAM}=${agentId}`;

describe("find_tool's Setup offer (GRA-210)", () => {
  it("names the ask card's resource on find_tool's definition, under both keys", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const { tools } = await hermes.client.listTools();
    expect(tools.find((tool) => tool.name === "find_tool")?._meta).toEqual(ASK_CARD_TOOL_META);
  });

  it("answers setup in the console form for a static-token agent, with no card, as a plain result", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const found = await hermes.findTool();
    expect(found.isError).toBeFalsy();
    const url = setupUrlOf(HERMES);
    const expected = { url, message: setupOfferMessage("console", url) };
    expect(text(found)).toMatchObject({ tools: [], connections: [], setup: expected });
    expect(text(found).setup).toEqual(expected);
    expect(found.structuredContent?.setup).toEqual(expected);
    expect(found.structuredContent?.card).toBeUndefined();
    expect(expected.message).toContain(`Relay this link so they can open Setup: ${url}`);
  });

  it("answers the card form, cardShown and the setup card for a client the server knows renders cards", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const found = await claude.findTool();
    expect(found.isError).toBeFalsy();
    const url = setupUrlOf(CLAUDE);
    const setup = { url, message: setupOfferMessage("card", url), cardShown: true };
    expect(text(found).setup).toEqual(setup);
    expect(found.structuredContent?.setup).toEqual(setup);
    const card: SetupCard = { kind: "setup", agentName: "Claude", url };
    expect(found.structuredContent?.card).toEqual(card);
    // The card rides in structuredContent alone; the model's text does not carry it.
    expect(text(found).card).toBeUndefined();
    expect(setup.message).toContain("offered as a card in this conversation");
    expect(setup.message).toContain(url);
  });

  it("carries the card on the session's first offer alone, and setup in the console form on every later one (GRA-212)", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const url = setupUrlOf(CLAUDE);
    const first = await claude.findTool();
    expect(first.structuredContent?.card).toEqual({ kind: "setup", agentName: "Claude", url });
    expect(text(first).setup).toMatchObject({ cardShown: true });

    // ChatGPT's five calls in one turn: the rest carry the offer and no card.
    const later = [];
    for (let i = 0; i < 4; i += 1) later.push(await claude.findTool());
    const consoleForm = { url, message: setupOfferMessage("console", url) };
    for (const found of later) {
      expect(found.isError).toBeFalsy();
      expect(found.structuredContent?.card).toBeUndefined();
      expect(text(found).setup).toEqual(consoleForm);
      expect(found.structuredContent?.setup).toEqual(consoleForm);
    }

    // A second session of the same agent is a new session, and shows the card once more.
    const again = await connect(TOKEN_CLAUDE);
    expect((await again.findTool()).structuredContent?.card).toMatchObject({ kind: "setup" });
  });

  it("carries one card when a session's find_tool calls are in flight together (GRA-212)", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const found = await Promise.all([claude.findTool(), claude.findTool(), claude.findTool()]);
    expect(found.filter((result) => result.structuredContent?.card !== undefined)).toHaveLength(1);
    for (const result of found) expect(text(result).setup).toBeDefined();
  });

  it("answers the console form and no card for an OAuth client nothing vouches for", async () => {
    const unknown = await connect(TOKEN_UNKNOWN);
    const found = await unknown.findTool();
    const url = setupUrlOf(UNKNOWN);
    expect(text(found).setup).toEqual({ url, message: setupOfferMessage("console", url) });
    expect(found.structuredContent?.card).toBeUndefined();
  });

  it("is still offered while Setup is under way, and ends once it is completed or skipped", async () => {
    const hermes = await connect(TOKEN_HERMES);
    store.saveSetup(PERSON, { step: "goal", agentId: HERMES, startedAt: store.now() });
    expect(text(await hermes.findTool()).setup).toBeDefined();

    store.saveSetup(PERSON, { step: "completed", completedAt: store.now() });
    const finished = await hermes.findTool();
    expect(text(finished).setup).toBeUndefined();
    expect(finished.structuredContent?.card).toBeUndefined();

    store.saveSetup(PERSON, { step: "harness", completedAt: null, skippedAt: store.now() });
    const claude = await connect(TOKEN_CLAUDE);
    const skipped = await claude.findTool();
    expect(text(skipped).setup).toBeUndefined();
    expect(skipped.structuredContent?.card).toBeUndefined();
  });

  it("is not offered to another agent while Setup runs as one, and is again once that one is revoked", async () => {
    // Setup is under way as Hermes; the page would resume it as Hermes, never as Claude.
    store.saveSetup(PERSON, { step: "vendor", agentId: HERMES, startedAt: store.now() });
    const claude = await connect(TOKEN_CLAUDE);
    const found = await claude.findTool();
    expect(found.isError).toBeFalsy();
    expect(text(found).setup).toBeUndefined();
    expect(found.structuredContent?.card).toBeUndefined();
    // Hermes itself is still offered the Setup it runs as.
    const hermes = await connect(TOKEN_HERMES);
    expect(text(await hermes.findTool()).setup).toEqual({
      url: setupUrlOf(HERMES),
      message: setupOfferMessage("console", setupUrlOf(HERMES)),
    });

    // Hermes revoked: a start adopts the agent it is opened for, so Claude is offered it again.
    const row = store.agents.get(HERMES);
    if (!row) throw new Error("no hermes");
    store.agents.set(HERMES, { ...row, revokedAt: store.now() });
    const again = await connect(TOKEN_CLAUDE);
    expect((await again.findTool()).structuredContent?.card).toMatchObject({
      kind: "setup",
      url: setupUrlOf(CLAUDE),
    });
  });

  it("ends at the person's first connection, made through the card, and a revoked one still ends it", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    expect((await claude.findTool()).structuredContent?.card).toMatchObject({ kind: "setup" });

    // The keyless proposal, confirmed on its card: the connection the offer was waiting for.
    const asked = await claude.call("request_connection", KEYLESS);
    const askId = text(asked).pendingActionId as string;
    const answered = await claude.call(ANSWER_ASK, {
      pendingActionId: askId,
      answer: { connect: true, approveBuild: true },
    });
    expect(answered.isError).toBeFalsy();

    const after = await claude.findTool();
    expect(text(after).setup).toBeUndefined();
    expect(after.structuredContent?.card).toBeUndefined();
    expect(text(after).connections).toEqual([
      expect.objectContaining({ vendor: "open-meteo", displayName: "Open-Meteo" }),
    ]);

    // Revoked, the row still counts: the person has made a connection, and the offer stays gone.
    for (const row of store.connections.values()) {
      if (row.personId === PERSON) row.revokedAt = store.now();
    }
    const hermes = await connect(TOKEN_HERMES);
    expect(text(await hermes.findTool()).setup).toBeUndefined();
  });

  it("gives answer_ask nothing to admit: the setup card names no ask", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = (await claude.findTool()).structuredContent?.card as Record<string, unknown>;
    expect(card).not.toHaveProperty("pendingActionId");
    const refused = await claude.call(ANSWER_ASK, {
      pendingActionId: "setup",
      answer: { allow: true },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatchObject({ error: "refused", reason: "ask_not_found" });
    expect(store.pendingActions.size).toBe(0);
  });
});
