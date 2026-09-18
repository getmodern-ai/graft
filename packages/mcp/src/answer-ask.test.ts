import type { AskCard } from "@graft/ask-card/shape";
import { createScriptedModel } from "@graft/model";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASK_ANSWERED_MESSAGE, ASK_EXPIRED_MESSAGE } from "./ask-answer";
import type { McpDeps } from "./deps";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { executeToolName } from "./tool-names";
import { ANSWER_ASK, CARD_NOT_AVAILABLE } from "./tools/answer-ask";

/**
 * The ask card's tool as a host would drive it (GRA-84; ADR 0006 as amended 2026-09-18), on the
 * suites' fixture shape: the SDK's client over the in-memory pair, the real services over the
 * in-memory fakes, no sandbox and no vendor — nothing here runs code. What is asserted is what
 * each side sees: the card data on an awaiting result, the sentence or the refusal the card gets
 * back, and what the waiting tool then does — `acquire` proceeds on a yes recorded through the
 * card exactly as on one recorded in the console, `request_connection` answers connected.
 *
 * Three agents of one person: `claude`, minted by an MCP client's consent (ADR 0018) and so the
 * one the card answers for; `other`, another such agent, whose asks are its own; and `hermes`,
 * a static-token agent whose harness renders no card and whose call can only be its model's.
 */

const PERSON = "person_1";
const CLAUDE = "agent_claude";
const OTHER = "agent_other";
const HERMES = "agent_hermes";
const TOKEN_CLAUDE = "grft_answer_ask_claude_000000000000000000000000";
const TOKEN_OTHER = "grft_answer_ask_other_0000000000000000000000000";
const TOKEN_HERMES = "grft_answer_ask_hermes_000000000000000000000000";
const CONN = "conn_demo";
const CONSOLE_URL = "http://console.graft.test";

const KEYLESS = {
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.com/v1",
  scheme: "none",
  docsUrl: "https://open-meteo.com/en/docs",
};

const SECRET = {
  vendor: "acme",
  displayName: "Acme Orders",
  primaryHost: "https://api.acme.example",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-acme-key" },
};

let store: FakeStore;
let deps: McpDeps;

beforeEach(() => {
  store = createFakeStore();
  store.addConnection({
    id: CONN,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example",
  });
  store.addAgent({
    id: CLAUDE,
    personId: PERSON,
    token: TOKEN_CLAUDE,
    name: "Claude",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_claude", clientName: "Claude" },
  });
  store.addAgent({
    id: OTHER,
    personId: PERSON,
    token: TOKEN_OTHER,
    name: "ChatGPT",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_openai", clientName: "ChatGPT" },
  });
  store.addAgent({
    id: HERMES,
    personId: PERSON,
    token: TOKEN_HERMES,
    name: "laptop Hermes",
    connectionIds: [CONN],
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
    }),
    runnerFiles: async () => [],
    skills: async () => [],
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    askCardHtml: async () => "<!doctype html>",
    model: createScriptedModel([]),
    handoff: {
      consoleUrl: CONSOLE_URL,
      secret: "graft-answer-ask-test-handoff-secret-long-enough-32",
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
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
  };
}

/** The text block the model reads, parsed. */
function text(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

/** The card on `structuredContent`, and the proof the text block does not carry it (GRA-55's shape stays). */
function cardOf(result: CallToolResult): AskCard {
  const structured = result.structuredContent as Record<string, unknown>;
  expect(structured.card).toBeDefined();
  expect(text(result)).not.toHaveProperty("card");
  const { card, ...rest } = structured;
  expect(rest).toEqual(text(result));
  return card as AskCard;
}

/** `answer_ask` as the card calls it. */
async function answer(
  agent: Awaited<ReturnType<typeof connect>>,
  pendingActionId: string,
  said: Record<string, unknown>,
) {
  const result = await agent.call(ANSWER_ASK, { pendingActionId, answer: said });
  return { result, body: text(result) };
}

describe("the card data on an awaiting result", () => {
  it("rides a build ask's awaiting_approval in structuredContent alone, answerable, with the connection's facts", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const result = await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ reason: "awaiting_approval", url: expect.any(String) });
    const card = cardOf(result);
    expect(card).toMatchObject({
      kind: "build",
      agentName: "Claude",
      vendor: "demo",
      displayName: "Demo Orders",
      primaryHost: "https://api.demo.example",
      hosts: ["api.demo.example"],
      scheme: "api_key_header",
      takesCredential: true,
      answerable: true,
      url: text(result).url,
      pendingActionId: text(result).pendingActionId,
    });
    expect(card.expiresAt).toBe(text(result).expiresAt);
  });

  it("rides a keyless proposal's awaiting_connection as answerable, and a secret scheme's as not", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const keyless = cardOf(await claude.call("request_connection", KEYLESS));
    expect(keyless).toMatchObject({
      kind: "connection",
      agentName: "Claude",
      vendor: "open-meteo",
      displayName: "Open-Meteo",
      primaryHost: "https://api.open-meteo.com/v1",
      hosts: ["api.open-meteo.com"],
      scheme: "none",
      takesCredential: false,
      docsUrl: "https://open-meteo.com/en/docs",
      provider: "keyring",
      providerConnect: "form",
      answerable: true,
    });
    const secret = cardOf(await claude.call("request_connection", SECRET));
    expect(secret).toMatchObject({
      scheme: "api_key_header",
      takesCredential: true,
      answerable: false,
    });
  });

  it("rides a credential ask's awaiting_credential, never answerable", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const result = await claude.call("request_credential", { connectionId: CONN, reason: "401" });
    expect(text(result)).toMatchObject({ reason: "awaiting_credential" });
    expect(cardOf(result)).toMatchObject({
      kind: "credential",
      displayName: "Demo Orders",
      hosts: ["api.demo.example"],
      answerable: false,
    });
  });
});

describe("answer_ask on a build ask", () => {
  it("refuses a static-token agent as card_not_available, naming the console, and records nothing", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const card = cardOf(await hermes.call("acquire", { connectionId: CONN, goal: "list orders" }));
    const { result, body } = await answer(hermes, card.pendingActionId, { allow: true });
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: "refused",
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("console"),
    });
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
    expect(store.buildApprovals.size).toBe(0);
  });

  it("records an OAuth agent's own yes with via: card, grants the build approval, and the next acquire starts the job", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    const { result, body } = await answer(claude, card.pendingActionId, { allow: true });
    expect(result.isError).toBeFalsy();
    expect(body).toMatchObject({
      answered: true,
      sentence: expect.stringContaining(
        "Allowed. Claude may build tools against Demo Orders (demo)",
      ),
    });
    const row = store.pendingActions.get(card.pendingActionId);
    expect(row?.answer).toEqual({ allow: true, via: "card" });
    expect(row?.answeredAt).not.toBeNull();
    // The row carries the whole yes, so the action is spent here, as the console's route spends it.
    expect(row?.consumedAt).not.toBeNull();
    expect(store.buildApprovals.get(`${CLAUDE} ${CONN}`)).toMatchObject({ connectionId: CONN });

    const again = await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    expect(again.isError).toBeFalsy();
    expect(text(again)).toMatchObject({ jobId: expect.any(String), status: "queued" });
  });

  it("records a no as the decline the console records: nothing granted, the next acquire asks afresh", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    const { body } = await answer(claude, card.pendingActionId, { allow: false });
    expect(body).toMatchObject({ answered: true, sentence: expect.stringContaining("Declined") });
    expect(store.pendingActions.get(card.pendingActionId)?.answer).toEqual({
      allow: false,
      via: "card",
    });
    expect(store.buildApprovals.size).toBe(0);
    const next = await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    expect(text(next)).toMatchObject({ reason: "approval_declined" });
    // The decline was taken by that call; the one after asks anew.
    const asked = await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    expect(text(asked)).toMatchObject({ reason: "awaiting_approval" });
    expect(text(asked).pendingActionId).not.toBe(card.pendingActionId);
  });

  it("refuses another agent's ask as ask_not_found, even for the same person", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const other = await connect(TOKEN_OTHER);
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    const { body } = await answer(other, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({ error: "refused", reason: "ask_not_found" });
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
  });

  it("refuses a second answer as answered, and an expired ask as expired, in the console's words", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    await answer(claude, card.pendingActionId, { allow: true });
    const twice = await answer(claude, card.pendingActionId, { allow: false });
    expect(twice.body).toMatchObject({ reason: "answered", message: ASK_ANSWERED_MESSAGE });

    deps.handoff.ttlMs = 1;
    const short = cardOf(await claude.call("request_connection", KEYLESS));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const late = await answer(claude, short.pendingActionId, { connect: true, approveBuild: true });
    expect(late.body).toMatchObject({ reason: "expired", message: ASK_EXPIRED_MESSAGE });
  });

  it("refuses a tool's first-use ask as card_not_available: the console keeps the session for a write", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const row = await deps.pendingAction.insertPendingAction(deps.db, {
      id: "pa_tool",
      agentId: CLAUDE,
      kind: "tool",
      payload: { toolId: "tool_1", toolName: "demo__create-order", connectionId: CONN },
      connectionId: CONN,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    const { body } = await answer(claude, row.id, { allow: true });
    expect(body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("console"),
    });
    expect(store.approvals.size).toBe(0);
  });

  it("refuses a malformed answer as input_invalid before reading anything", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    for (const args of [
      {},
      { pendingActionId: "pa_x" },
      { pendingActionId: "pa_x", answer: { allow: "yes" } },
      { pendingActionId: "pa_x", answer: { connect: true } },
      { pendingActionId: "pa_x", answer: { allow: true, decline: true } },
    ]) {
      const result = await claude.call(ANSWER_ASK, args);
      expect(text(result), JSON.stringify(args)).toMatchObject({ reason: "input_invalid" });
    }
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    const wrongShape = await answer(claude, card.pendingActionId, { decline: true });
    expect(wrongShape.body).toMatchObject({ reason: "input_invalid" });
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
  });
});

describe("answer_ask on a connection ask", () => {
  it("connects a keyless proposal with the build approval, in the asking agent's scope, and request_connection then answers connected", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", KEYLESS));
    const { body } = await answer(claude, card.pendingActionId, {
      connect: true,
      approveBuild: true,
    });
    expect(body).toMatchObject({
      answered: true,
      sentence: expect.stringContaining("Connected. Open-Meteo (open-meteo) is in Claude's scope"),
    });
    expect(body.sentence).toContain("may build tools against it");

    const row = store.pendingActions.get(card.pendingActionId);
    const connectionId = row?.answer?.connectionId as string;
    expect(row?.answer).toEqual({ connectionId, via: "card" });
    const connection = store.connections.get(connectionId);
    expect(connection).toMatchObject({
      vendor: "open-meteo",
      scheme: "none",
      hosts: ["api.open-meteo.com"],
      credentialCiphertext: null,
    });
    expect(store.agentConnections.get(CLAUDE)?.has(connectionId)).toBe(true);
    expect(store.agentConnections.get(OTHER)?.has(connectionId)).toBe(false);
    expect(store.buildApprovals.get(`${CLAUDE} ${connectionId}`)).toBeDefined();

    const again = await claude.call("request_connection", KEYLESS);
    expect(again.isError).toBeFalsy();
    expect(text(again)).toMatchObject({ status: "connected", connectionId });
    expect(await claude.toolNames()).toContain(executeToolName(connectionId));
    // The approval given on the card stands, so acquire against the new connection asks nothing.
    const job = await claude.call("acquire", { connectionId, goal: "today's forecast" });
    expect(text(job)).toMatchObject({ jobId: expect.any(String) });
  });

  it("connects without the build approval when the person unticked it, and acquire then asks", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", KEYLESS));
    const { body } = await answer(claude, card.pendingActionId, {
      connect: true,
      approveBuild: false,
    });
    expect(body.sentence).not.toContain("may build tools");
    const connectionId = store.pendingActions.get(card.pendingActionId)?.answer
      ?.connectionId as string;
    expect(store.buildApprovals.get(`${CLAUDE} ${connectionId}`)).toBeUndefined();
    expect(text(await claude.call("acquire", { connectionId, goal: "forecast" }))).toMatchObject({
      reason: "awaiting_approval",
    });
  });

  it("records a decline as the console's generic decline, and request_connection says so", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", KEYLESS));
    const { body } = await answer(claude, card.pendingActionId, { decline: true });
    expect(body).toMatchObject({ answered: true, sentence: expect.stringContaining("Declined") });
    expect(store.pendingActions.get(card.pendingActionId)?.answer).toEqual({
      allow: false,
      via: "card",
    });
    expect(store.connections.size).toBe(1);
    expect(text(await claude.call("request_connection", KEYLESS))).toMatchObject({
      reason: "connection_declined",
    });
  });

  it("refuses a proposal whose scheme takes a secret as card_not_available: the secret is the console's", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", SECRET));
    expect(card.answerable).toBe(false);
    const { body } = await answer(claude, card.pendingActionId, {
      connect: true,
      approveBuild: true,
    });
    expect(body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("credential is entered there"),
    });
    expect(store.connections.size).toBe(1);
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
  });

  it("refuses a build-shaped answer on a connection ask as input_invalid", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", KEYLESS));
    const { body } = await answer(claude, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({ reason: "input_invalid" });
    expect(store.connections.size).toBe(1);
  });
});
