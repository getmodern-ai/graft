import type { AskCard } from "@graft/ask-card/shape";
import { createScriptedModel } from "@graft/model";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASK_ANSWERED_MESSAGE, ASK_EXPIRED_MESSAGE } from "./ask-answer";
import { redirectsOnCardHosts } from "./ask-card";
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
 * Five agents of one person: `claude`, minted by an MCP client's consent (ADR 0018) from a client
 * registered on `claude.ai`, and so the one the card answers for; `other`, ChatGPT's, whose asks
 * are its own; `hermes`, a static-token agent whose harness renders no card and whose call can
 * only be its model's; and two OAuth agents whose clients are not known to hide the tool — one
 * registered on an unknown host, one with a second redirect off the list — which the gate refuses
 * unless their session declared the MCP Apps extension.
 */

const PERSON = "person_1";
const CLAUDE = "agent_claude";
const OTHER = "agent_other";
const HERMES = "agent_hermes";
const TOKEN_CLAUDE = "grft_answer_ask_claude_000000000000000000000000";
const TOKEN_OTHER = "grft_answer_ask_other_0000000000000000000000000";
const TOKEN_HERMES = "grft_answer_ask_hermes_000000000000000000000000";
const UNKNOWN = "agent_unknown";
const MIXED = "agent_mixed";
const TOKEN_UNKNOWN = "grft_answer_ask_unknown_00000000000000000000000";
const TOKEN_MIXED = "grft_answer_ask_mixed_000000000000000000000000000";
/** The extension a client that implements MCP Apps declares in `initialize` — ChatGPT does, Claude.ai web does not. */
const UI_EXTENSION = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
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
/** The suite's clock: every row's stamp and every expiry check read it, so a test moves time by setting it. */
let clock: Date;

beforeEach(() => {
  clock = new Date("2026-09-18T10:00:00Z");
  store = createFakeStore({ now: () => clock });
  store.addConnection({
    id: CONN,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example",
  });
  store.addAgent({
    scopeMode: "listed",
    id: CLAUDE,
    personId: PERSON,
    token: TOKEN_CLAUDE,
    name: "Claude",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_claude", clientName: "Claude" },
  });
  store.addAgent({
    scopeMode: "listed",
    id: OTHER,
    personId: PERSON,
    token: TOKEN_OTHER,
    name: "ChatGPT",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_openai", clientName: "ChatGPT" },
  });
  store.addAgent({
    scopeMode: "listed",
    id: HERMES,
    personId: PERSON,
    token: TOKEN_HERMES,
    name: "laptop Hermes",
    connectionIds: [CONN],
  });
  // The two products' registrations, by the callbacks they register (the GRA-84 research), and two
  // clients whose hiding of app-only tools nothing establishes.
  store.addMcpClient({
    id: "client_claude",
    name: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  store.addMcpClient({
    id: "client_openai",
    name: "ChatGPT",
    redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  });
  store.addMcpClient({
    id: "client_unknown",
    name: "Some Client",
    redirectUris: ["https://evil.example/cb"],
  });
  store.addMcpClient({
    id: "client_mixed",
    name: "Mixed Client",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"],
  });
  store.addAgent({
    scopeMode: "listed",
    id: UNKNOWN,
    personId: PERSON,
    token: TOKEN_UNKNOWN,
    name: "Some Client",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_unknown", clientName: "Some Client" },
  });
  store.addAgent({
    scopeMode: "listed",
    id: MIXED,
    personId: PERSON,
    token: TOKEN_MIXED,
    name: "Mixed Client",
    connectionIds: [CONN],
    connectedVia: { clientId: "client_mixed", clientName: "Mixed Client" },
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

async function connect(token: string, options: { declaresExtension?: boolean } = {}) {
  const notifier = createToolListChangedNotifier({ windowMs: 50 });
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client(
    { name: "chat-product", version: "0.0.0" },
    options.declaresExtension ? { capabilities: { extensions: UI_EXTENSION } } : {},
  );
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
    // A result, not an error (GRA-112): a host mounts no view for an error result.
    expect(result.isError).toBe(false);
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

    // The ask is made at the clock's time and expires `ttlMs` later; moving the clock past that
    // is the expiry, with no real time involved — a 1 ms TTL and a sleep raced the call's own poll
    // on a slow runner (CI run 35314739132), which then answered `handoff_expired` with no card.
    const short = cardOf(await claude.call("request_connection", KEYLESS));
    expect(new Date(short.expiresAt).getTime()).toBe(clock.getTime() + deps.handoff.ttlMs);
    clock = new Date(clock.getTime() + deps.handoff.ttlMs + 1);
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
      expiresAt: new Date(clock.getTime() + 60_000),
      createdAt: clock,
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

/**
 * The third card (GRA-104): a connection the person holds that this agent was not given. ChatGPT's
 * agent holds Delta; Claude proposes it and gets a `scope` ask, answerable since nothing is
 * entered. Allow through the card is the console's record — the scope grant and, with the choice
 * on, the build approval — and `request_connection` then answers connected; the static-token
 * agent is refused at guard 1 as for every card.
 */
describe("answer_ask on a scope ask", () => {
  const DELTA_CONN = "conn_delta";
  const DELTA = {
    vendor: "delta",
    displayName: "Delta Books",
    primaryHost: "https://api.delta.example/v1",
    scheme: "api_key_header",
    schemeConfig: { headerName: "x-delta-key" },
    docsUrl: "https://developer.delta.example/docs",
  };

  beforeEach(() => {
    store.addConnection({
      id: DELTA_CONN,
      personId: PERSON,
      vendor: "delta",
      displayName: "Delta Books",
      primaryHost: "https://api.delta.example/v1",
      schemeConfig: { headerName: "x-delta-key" },
    });
    store.agentConnections.get(OTHER)?.add(DELTA_CONN);
  });

  it("rides awaiting_scope as an answerable card with the row's facts and the documentation proposed", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const result = await claude.call("request_connection", DELTA);
    expect(text(result)).toMatchObject({
      error: "awaiting_scope",
      reason: "awaiting_scope",
      connectionId: DELTA_CONN,
      provider: "keyring",
    });
    expect(cardOf(result)).toMatchObject({
      kind: "scope",
      answerable: true,
      agentName: "Claude",
      vendor: "delta",
      displayName: "Delta Books",
      primaryHost: "https://api.delta.example/v1",
      hosts: ["api.delta.example"],
      scheme: "api_key_header",
      takesCredential: true,
      docsUrl: "https://developer.delta.example/docs",
    });
    expect(cardOf(result)).not.toHaveProperty("provider");
  });

  it("records an Allow with the build choice as the console does, and request_connection then answers connected with the execute tool", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", DELTA));
    const { body } = await answer(claude, card.pendingActionId, {
      allow: true,
      approveBuild: true,
    });
    expect(body).toMatchObject({
      answered: true,
      sentence: expect.stringContaining("Allowed. Delta Books (delta) is in Claude's scope"),
    });
    expect(body.sentence).toContain("may build tools against it");
    expect(store.pendingActions.get(card.pendingActionId)?.answer).toEqual({
      allow: true,
      approveBuild: true,
      via: "card",
    });
    expect(store.agentConnections.get(CLAUDE)?.has(DELTA_CONN)).toBe(true);
    expect(store.agentConnections.get(OTHER)?.has(DELTA_CONN)).toBe(true);
    expect(store.agentConnections.get(HERMES)?.has(DELTA_CONN)).toBe(false);
    expect(store.buildApprovals.get(`${CLAUDE} ${DELTA_CONN}`)).toBeDefined();
    // No new row: the person's one connection, now in two scopes.
    expect([...store.connections.values()].filter((row) => row.vendor === "delta")).toHaveLength(1);

    const again = await claude.call("request_connection", DELTA);
    expect(again.isError).toBeFalsy();
    expect(text(again)).toMatchObject({
      status: "connected",
      connectionId: DELTA_CONN,
      executeTool: executeToolName(DELTA_CONN),
    });
    expect(await claude.toolNames()).toContain(executeToolName(DELTA_CONN));
    const job = await claude.call("acquire", { connectionId: DELTA_CONN, goal: "list books" });
    expect(text(job)).toMatchObject({ jobId: expect.any(String) });
  });

  it("records an Allow with the choice off: in scope, no build approval, and acquire then asks", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", DELTA));
    const { body } = await answer(claude, card.pendingActionId, {
      allow: true,
      approveBuild: false,
    });
    expect(body.sentence).not.toContain("may build tools");
    expect(store.agentConnections.get(CLAUDE)?.has(DELTA_CONN)).toBe(true);
    expect(store.buildApprovals.get(`${CLAUDE} ${DELTA_CONN}`)).toBeUndefined();
    expect(text(await claude.call("request_connection", DELTA))).toMatchObject({
      status: "connected",
    });
    expect(
      text(await claude.call("acquire", { connectionId: DELTA_CONN, goal: "x" })),
    ).toMatchObject({ reason: "awaiting_approval" });
  });

  it("records a Decline as the console's, growing nothing, and request_connection says scope_declined", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", DELTA));
    const { body } = await answer(claude, card.pendingActionId, { allow: false });
    expect(body).toMatchObject({ answered: true, sentence: expect.stringContaining("Declined") });
    expect(store.pendingActions.get(card.pendingActionId)?.answer).toEqual({
      allow: false,
      via: "card",
    });
    expect(store.agentConnections.get(CLAUDE)?.has(DELTA_CONN)).toBe(false);
    expect(text(await claude.call("request_connection", DELTA))).toMatchObject({
      reason: "scope_declined",
      connectionId: DELTA_CONN,
    });
  });

  it("refuses a static-token agent's scope ask as card_not_available, and a connect-shaped answer as input_invalid", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const card = cardOf(await hermes.call("request_connection", DELTA));
    expect(card).toMatchObject({ kind: "scope", answerable: true });
    const refused = await answer(hermes, card.pendingActionId, { allow: true, approveBuild: true });
    expect(refused.body).toMatchObject({ reason: CARD_NOT_AVAILABLE });
    expect(store.agentConnections.get(HERMES)?.has(DELTA_CONN)).toBe(false);
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();

    const claude = await connect(TOKEN_CLAUDE);
    const own = cardOf(await claude.call("request_connection", DELTA));
    const wrong = await answer(claude, own.pendingActionId, { connect: true, approveBuild: true });
    expect(wrong.body).toMatchObject({ reason: "input_invalid" });
    expect(store.agentConnections.get(CLAUDE)?.has(DELTA_CONN)).toBe(false);
  });

  it("refuses approveBuild on a build ask as input_invalid: the choice is the scope and connection asks' alone", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list orders" }));
    expect(card.kind).toBe("build");
    const { body } = await answer(claude, card.pendingActionId, {
      allow: true,
      approveBuild: true,
    });
    expect(body).toMatchObject({ reason: "input_invalid" });
    expect(store.buildApprovals.get(`${CLAUDE} ${CONN}`)).toBeUndefined();
  });
});

/**
 * Guard 1's second half (Greptile on #71): the OAuth grant alone admits any dynamically registered
 * client, so the card's tool answers only for a client whose hiding of app-only tools is
 * established — every registered redirect on a card host, or the extension declared in
 * `initialize`. The signals are the registration and the handshake, neither of which the model
 * can write to.
 */
describe("the card-host gate", () => {
  const ask = async (agent: Awaited<ReturnType<typeof connect>>) =>
    cardOf(await agent.call("acquire", { connectionId: CONN, goal: "list orders" }));

  it("admits a client registered on claude.ai, and one on chatgpt.com", async () => {
    for (const token of [TOKEN_CLAUDE, TOKEN_OTHER]) {
      const agent = await connect(token);
      const card = await ask(agent);
      const { body } = await answer(agent, card.pendingActionId, { allow: true });
      expect(body, token).toMatchObject({ answered: true });
    }
  });

  it("refuses a client registered on an unknown host, and one with a second redirect off the list", async () => {
    for (const token of [TOKEN_UNKNOWN, TOKEN_MIXED]) {
      const agent = await connect(token);
      const card = await ask(agent);
      const { body } = await answer(agent, card.pendingActionId, { allow: true });
      expect(body, token).toMatchObject({
        error: "refused",
        reason: CARD_NOT_AVAILABLE,
        message: expect.stringContaining("console"),
      });
      expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
      expect(store.buildApprovals.size).toBe(0);
    }
  });

  it("admits an off-list client whose session declared the MCP Apps extension", async () => {
    const agent = await connect(TOKEN_UNKNOWN, { declaresExtension: true });
    const card = await ask(agent);
    const { body } = await answer(agent, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({ answered: true });
    expect(store.buildApprovals.get(`${UNKNOWN} ${CONN}`)).toBeDefined();
  });

  it("still refuses a static-token agent, even one whose session declared the extension", async () => {
    const hermes = await connect(TOKEN_HERMES, { declaresExtension: true });
    const card = await ask(hermes);
    const { body } = await answer(hermes, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({ reason: CARD_NOT_AVAILABLE });
  });

  it("admits a self-hoster's host through GRAFT_CARD_HOSTS, and a subdomain of a listed host", async () => {
    const token = "grft_answer_ask_self_0000000000000000000000000000";
    store.addMcpClient({
      id: "client_self",
      name: "Own Chat",
      redirectUris: ["https://connectors.chat.self-host.example/oauth/cb"],
    });
    store.addAgent({
      scopeMode: "listed",
      id: "agent_self",
      personId: PERSON,
      token,
      name: "Own Chat",
      connectionIds: [CONN],
      connectedVia: { clientId: "client_self", clientName: "Own Chat" },
    });
    const before = await connect(token);
    const card = await ask(before);
    expect((await answer(before, card.pendingActionId, { allow: true })).body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
    });

    deps.cardHosts = ["claude.ai", "chatgpt.com", "chat.self-host.example"];
    const after = await connect(token);
    expect((await answer(after, card.pendingActionId, { allow: true })).body).toMatchObject({
      answered: true,
    });
  });

  it("reads every redirect: a list with none, or one that does not parse, admits nobody", () => {
    expect(redirectsOnCardHosts([], ["claude.ai"])).toBe(false);
    expect(redirectsOnCardHosts(["not a url"], ["claude.ai"])).toBe(false);
    expect(redirectsOnCardHosts(["https://claude.ai/cb"], [])).toBe(false);
    expect(
      redirectsOnCardHosts(["https://CLAUDE.AI/cb", "https://app.claude.ai/x"], ["claude.ai"]),
    ).toBe(true);
    expect(redirectsOnCardHosts(["https://notclaude.ai/cb"], ["claude.ai"])).toBe(false);
  });
});
