import type { AskCard } from "@graft/ask-card/shape";
import { answerPendingAction, keyringProvider } from "@graft/core";
import {
  createFakeLinkProvider,
  type FakeLinkProvider,
  FakeLinkProviderError,
} from "@graft/core/connection/testing/fake-link-provider";
import { createScriptedModel } from "@graft/model";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASK_ANSWERED_MESSAGE, ASK_EXPIRED_MESSAGE } from "./ask-answer";
import { redirectsOnCardHosts } from "./ask-card";
import type { McpDeps } from "./deps";
import { cardHandoffSentence } from "./handoff-message";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { executeToolName } from "./tool-names";
import { ANSWER_ASK, CARD_NOT_AVAILABLE } from "./tools/answer-ask";
import { ASK_OPEN_SENTENCE, ASK_STATUS } from "./tools/ask-status";
import { START_LINK } from "./tools/start-link";

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
 * registered on an unknown host, one with a second redirect off the list — which the gate
 * refuses, whatever their session declared (GRA-150).
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
/**
 * The extension a client that implements MCP Apps declares in `initialize` — ChatGPT does,
 * Claude.ai web does not. Observed and never admitted on (GRA-150), so every test that sets it
 * asserts the verdict is the registration's either way.
 */
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

  it("refuses a credential ask as card_not_available: the secret is the console's", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_credential", { connectionId: CONN }));
    const { body } = await answer(claude, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("console"),
    });
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
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

/**
 * The fourth card (GRA-116): a write's first use. The ask is inserted as `approval.ts` records it
 * — an authored tool's run needs a sandbox this suite has not — and answered through the card;
 * what is asserted is the standing approval the console's route would write, the setting left
 * alone, and the action spent or left for the waiting call exactly as `recordApprovalAnswer` does.
 */
describe("answer_ask on a tool ask", () => {
  beforeEach(() => {
    store.addTool({
      id: "tool_1",
      personId: PERSON,
      vendor: "demo",
      name: "create-order",
      description: "Creates a sales order at Demo.",
      inputSchema: { type: "object" },
      readOnly: false,
      destructive: false,
      defaultConnectionId: CONN,
      path: "tools/demo/create-order/v1",
    });
  });

  const toolAsk = (agentId: string, askEveryCall = false) =>
    deps.pendingAction.insertPendingAction(deps.db, {
      id: `pa_tool_${store.newId()}`,
      agentId,
      kind: "tool",
      payload: {
        toolId: "tool_1",
        toolName: "demo__create-order",
        vendor: "demo",
        description: "Creates a sales order at Demo.",
        annotations: { readOnlyHint: false, destructiveHint: false },
        connectionId: CONN,
        connectionName: "Demo Orders",
        hosts: ["api.demo.example"],
        note: "",
        askEveryCall,
      },
      connectionId: CONN,
      expiresAt: new Date(clock.getTime() + 60_000),
      createdAt: clock,
    });

  it("records an Allow as the standing approval, spends the action, and leaves the setting alone", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const row = await toolAsk(CLAUDE);
    const { result, body } = await answer(claude, row.id, { allow: true });
    expect(result.isError, JSON.stringify(body)).toBeFalsy();
    expect(body).toMatchObject({
      answered: true,
      sentence: expect.stringContaining("Allowed. Claude may run demo__create-order"),
    });
    expect(store.pendingActions.get(row.id)?.answer).toEqual({ allow: true, via: "card" });
    expect(store.pendingActions.get(row.id)?.consumedAt).not.toBeNull();
    expect(store.approvals.get(`${CLAUDE} tool_1`)).toMatchObject({
      decision: "allow",
      askEveryCall: false,
    });
  });

  it("records a Deny as the standing no, which holds", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const row = await toolAsk(CLAUDE);
    const { body } = await answer(claude, row.id, { allow: false });
    expect(body).toMatchObject({ answered: true, sentence: expect.stringContaining("Denied") });
    expect(store.approvals.get(`${CLAUDE} tool_1`)).toMatchObject({ decision: "deny" });
    expect(store.pendingActions.get(row.id)?.consumedAt).not.toBeNull();
  });

  it("on a tool set to ask every call, an Allow is for that one call: the action stays for it, the setting stays on, and the sentence says so", async () => {
    await deps.approval.upsertApproval(deps.db, {
      agentId: CLAUDE,
      toolId: "tool_1",
      decision: "allow",
      decidedAt: clock,
      askEveryCall: true,
    });
    const claude = await connect(TOKEN_CLAUDE);
    const row = await toolAsk(CLAUDE, true);
    const { body } = await answer(claude, row.id, { allow: true });
    expect(body.sentence).toContain("Allowed for this call");
    expect(store.approvals.get(`${CLAUDE} tool_1`)).toMatchObject({
      decision: "allow",
      askEveryCall: true,
    });
    const after = store.pendingActions.get(row.id);
    expect(after?.answeredAt).not.toBeNull();
    // Left for the waiting call to take, as the console's answer is.
    expect(after?.consumedAt).toBeNull();
  });

  it("refuses the setting on the answer as input_invalid, a static-token agent as card_not_available, and another agent's ask as ask_not_found", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const row = await toolAsk(CLAUDE);
    const wrong = await answer(claude, row.id, { allow: true, approveBuild: true });
    expect(wrong.body).toMatchObject({ reason: "input_invalid" });
    const other = await connect(TOKEN_OTHER);
    expect((await answer(other, row.id, { allow: true })).body).toMatchObject({
      reason: "ask_not_found",
    });

    const hermes = await connect(TOKEN_HERMES);
    const own = await toolAsk(HERMES);
    expect((await answer(hermes, own.id, { allow: true })).body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
    });
    expect(store.approvals.size).toBe(0);
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
    // A chat product's agent lists no execute__ tool (GRA-125); it learns the connection from
    // find_tool's connections instead, which is what acquire takes below.
    expect(await claude.toolNames()).not.toContain(executeToolName(connectionId));
    const found = text(await claude.call("find_tool", { query: "forecast weather" }));
    expect(found.connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId, vendor: KEYLESS.vendor })]),
    );
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
      message: expect.stringContaining("credential is entered in the console"),
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
    // No execute__ tool for a chat product's agent (GRA-125); the connection is in scope all the same.
    expect(await claude.toolNames()).not.toContain(executeToolName(DELTA_CONN));
    const found = text(await claude.call("find_tool", { query: "delta" }));
    expect(found.connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: DELTA_CONN })]),
    );
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
 * established — every registered redirect on a card host (`GRAFT_CARD_HOSTS`), and nothing else.
 * The client's own `initialize` was a second signal until ADR 0006's amendment of 2026-09-21
 * (GRA-150) and is none now: a client writes that handshake itself, so it admitted exactly the
 * clients nobody vouched for. The registration is not the client's to write: finishing Graft's
 * OAuth flow means controlling the callback it named.
 */
describe("the card-host gate", () => {
  const ask = async (agent: Awaited<ReturnType<typeof connect>>) =>
    cardOf(await agent.call("acquire", { connectionId: CONN, goal: "list orders" }));

  it("admits a client registered on claude.ai, and one on chatgpt.com, declaring nothing", async () => {
    // Claude.ai's shape: it renders the card and declares no extension in `initialize`.
    for (const token of [TOKEN_CLAUDE, TOKEN_OTHER]) {
      const agent = await connect(token);
      const card = await ask(agent);
      const { body } = await answer(agent, card.pendingActionId, { allow: true });
      expect(body, token).toMatchObject({ answered: true });
    }
  });

  it("admits an on-list client whose session declared the extension too", async () => {
    // ChatGPT's shape. The declaration moves nothing either way; the registration is the rule.
    const chatgpt = await connect(TOKEN_OTHER, { declaresExtension: true });
    const card = await ask(chatgpt);
    expect((await answer(chatgpt, card.pendingActionId, { allow: true })).body).toMatchObject({
      answered: true,
    });
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

  it("refuses an off-list client whose session declared the MCP Apps extension: the client writes its own initialize", async () => {
    const agent = await connect(TOKEN_UNKNOWN, { declaresExtension: true });
    const card = await ask(agent);
    const { body } = await answer(agent, card.pendingActionId, { allow: true });
    expect(body).toMatchObject({
      error: "refused",
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("GRAFT_CARD_HOSTS"),
    });
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
    expect(store.buildApprovals.get(`${UNKNOWN} ${CONN}`)).toBeUndefined();
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

/**
 * The card starts a link provider's connect and waits on it (GRA-117, GRA-118). The provider is
 * `@graft/core`'s fake link provider covering Gmail — the hosted form's broker is the private
 * package's (GRA-103) — so what is asserted is the link the fake minted: the return URIs on this
 * server's origin, the signed state, `from=card`, and the ask left open for the return to answer;
 * the return itself is `apps/server/src/provider-link.test.ts`. Then `ask_status` through every
 * state, on this ask and on the others.
 */
describe("start_link and ask_status", () => {
  const GMAIL = {
    vendor: "gmail",
    displayName: "Gmail",
    primaryHost: "https://gmail.googleapis.com/gmail/v1",
    hosts: ["www.googleapis.com"],
    scheme: "oauth_authorization_code",
    schemeConfig: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    },
  };
  const AUTH_URL = "http://graft.test";
  let broker: FakeLinkProvider;

  beforeEach(() => {
    broker = createFakeLinkProvider({ name: "broker", covers: (vendor) => vendor === "gmail" });
    deps.connection = { ...deps.connection, providers: [broker, keyringProvider] };
    deps.authUrl = AUTH_URL;
  });

  const status = async (agent: Awaited<ReturnType<typeof connect>>, pendingActionId: string) =>
    text(await agent.call(ASK_STATUS, { pendingActionId }));
  const startLink = async (
    agent: Awaited<ReturnType<typeof connect>>,
    args: Record<string, unknown>,
  ) => text(await agent.call(START_LINK, args));

  it("rides a link provider's proposal as a card that names the provider and is not answerable", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const result = await claude.call("request_connection", GMAIL);
    expect(text(result)).toMatchObject({ reason: "awaiting_connection", provider: "broker" });
    expect(cardOf(result)).toMatchObject({
      kind: "connection",
      provider: "broker",
      providerConnect: "link",
      answerable: false,
      hosts: ["gmail.googleapis.com", "www.googleapis.com"],
    });
  });

  it("mints the provider's link for the agent's own ask with the build choice, both return URIs on this server with from=card, and leaves the ask open", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", GMAIL));
    const result = await claude.call(START_LINK, {
      pendingActionId: card.pendingActionId,
      approveBuild: true,
    });
    expect(result.isError).toBeFalsy();
    const started = text(result);
    expect(started).toMatchObject({ provider: "broker", url: expect.any(String) });
    expect(new URL(started.url as string).searchParams.get("app")).toBe("gmail");
    expect(new Date(started.expiresAt as string).getTime()).toBeGreaterThan(clock.getTime());

    const minted = broker.minted.at(-1);
    expect(minted).toMatchObject({ personId: PERSON, target: "gmail" });
    for (const [uri, outcome] of [
      [minted?.success, "success"],
      [minted?.error, "error"],
    ] as const) {
      const url = new URL(uri ?? "");
      expect(url.origin + url.pathname).toBe(`${AUTH_URL}/api/providers/link/callback`);
      expect(url.searchParams.get("outcome")).toBe(outcome);
      expect(url.searchParams.get("from")).toBe("card");
      expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
    // The ask is the return's to answer; the card reads it as open meanwhile.
    expect(store.pendingActions.get(card.pendingActionId)?.answeredAt).toBeNull();
    expect(await status(claude, card.pendingActionId)).toEqual({
      state: "open",
      sentence: ASK_OPEN_SENTENCE,
    });

    // The return made the row and answered the ask (`provider-link.ts`): the card reads connected.
    await answerPendingAction(
      { db: deps.db },
      { personId: PERSON },
      card.pendingActionId,
      { connectionId: "conn_gmail" },
      deps.pendingAction,
    );
    expect(await status(claude, card.pendingActionId)).toMatchObject({
      state: "answered",
      sentence: expect.stringContaining("Connected through broker. Gmail (gmail)"),
    });
  });

  it("declines a link provider's ask through answer_ask, and refuses its connect: the return makes the row", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", GMAIL));
    const connected = await answer(claude, card.pendingActionId, {
      connect: true,
      approveBuild: true,
    });
    expect(connected.body).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("start_link"),
    });
    const declined = await answer(claude, card.pendingActionId, { decline: true });
    expect(declined.body).toMatchObject({ answered: true });
    expect(store.pendingActions.get(card.pendingActionId)?.answer).toEqual({
      allow: false,
      via: "card",
    });
    expect(await status(claude, card.pendingActionId)).toMatchObject({
      state: "declined",
      sentence: expect.stringContaining("Declined"),
    });
    expect(text(await claude.call("request_connection", GMAIL))).toMatchObject({
      reason: "connection_declined",
    });
  });

  /** GRA-147: a provider whose `start` fails steps aside; the card's console button lands on the form. */
  it("start_link on a provider that cannot start answers card_not_available pointing at Graft's own page, and the ask is the keyring's form from then on", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const card = cardOf(await claude.call("request_connection", GMAIL));
    broker.failNext(new FakeLinkProviderError("the broker refused to mint (fake)"));
    const result = await claude.call(START_LINK, { pendingActionId: card.pendingActionId });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({
      reason: "card_not_available",
      message: expect.stringContaining("broker could not start its sign-in"),
    });
    expect(String(text(result).message)).toContain("Graft's own page");
    const row = store.pendingActions.get(card.pendingActionId);
    expect(row?.answeredAt).toBeNull();
    expect(row?.payload).toMatchObject({
      provider: "keyring",
      providerConnect: "form",
      providerFallback: { from: "broker" },
    });
    // The repeated call is the form's: the card is answerable-by-console, no provider named.
    const again = await claude.call("request_connection", GMAIL);
    expect(text(again)).toMatchObject({
      reason: "awaiting_connection",
      pendingActionId: card.pendingActionId,
    });
    expect(text(again).provider).toBeUndefined();
    expect(cardOf(again)).toMatchObject({ provider: "keyring", providerConnect: "form" });
    expect(String(text(again).message)).not.toContain("broker");
  });

  it("refuses start_link under the card gate and for an ask no link serves", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const own = cardOf(await hermes.call("request_connection", GMAIL));
    expect(await startLink(hermes, { pendingActionId: own.pendingActionId })).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
    });

    const claude = await connect(TOKEN_CLAUDE);
    expect(await startLink(claude, { pendingActionId: own.pendingActionId })).toMatchObject({
      reason: "ask_not_found",
    });
    const keyless = cardOf(await claude.call("request_connection", KEYLESS));
    expect(await startLink(claude, { pendingActionId: keyless.pendingActionId })).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("credential is entered"),
    });
    const build = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list" }));
    expect(await startLink(claude, { pendingActionId: build.pendingActionId })).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
    });
    expect(await startLink(claude, { pendingActionId: "" })).toMatchObject({
      reason: "input_invalid",
    });
    expect(
      await startLink(claude, { pendingActionId: keyless.pendingActionId, approveBuild: "yes" }),
    ).toMatchObject({ reason: "input_invalid" });
    expect(broker.minted).toHaveLength(0);

    // A server with no public URL cannot say where the return lands.
    deps.authUrl = undefined;
    const gmail = cardOf(await claude.call("request_connection", GMAIL));
    expect(await startLink(claude, { pendingActionId: gmail.pendingActionId })).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
      message: expect.stringContaining("public URL"),
    });
  });

  it("reads a secret's connection ask through the console's answer, a credential ask, a build ask and an expiry", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const secretResult = await claude.call("request_connection", SECRET);
    expect(text(secretResult)).toMatchObject({ reason: "awaiting_connection" });
    const secret = cardOf(secretResult);
    expect(await status(claude, secret.pendingActionId)).toEqual({
      state: "open",
      sentence: ASK_OPEN_SENTENCE,
    });
    // The console's form stored the credential and answered the ask (GRA-28).
    await answerPendingAction(
      { db: deps.db },
      { personId: PERSON },
      secret.pendingActionId,
      { connectionId: "conn_acme" },
      deps.pendingAction,
    );
    expect(await status(claude, secret.pendingActionId)).toEqual({
      state: "answered",
      sentence:
        "Connected. Acme Orders (acme) is in Claude's scope; the credential is stored and never shown again.",
    });

    const credential = cardOf(await claude.call("request_credential", { connectionId: CONN }));
    await answerPendingAction(
      { db: deps.db },
      { personId: PERSON },
      credential.pendingActionId,
      { connectionId: CONN },
      deps.pendingAction,
    );
    expect(await status(claude, credential.pendingActionId)).toMatchObject({
      state: "answered",
      sentence: expect.stringContaining(
        "Connected; the credential is stored and never shown again",
      ),
    });

    // A build ask answered on the card reads answered, spent or not.
    const build = cardOf(await claude.call("acquire", { connectionId: CONN, goal: "list" }));
    await answer(claude, build.pendingActionId, { allow: true });
    expect(await status(claude, build.pendingActionId)).toMatchObject({
      state: "answered",
      sentence: expect.stringContaining("Allowed. Claude may build tools against Demo Orders"),
    });

    // Past its time unanswered: expired, in the console's words. A fresh ask — the credential
    // ask above was answered, and asking again would take that answer and say connected.
    const late = cardOf(
      await claude.call("request_connection", {
        ...SECRET,
        vendor: "beta",
        displayName: "Beta",
        primaryHost: "https://api.beta.example",
      }),
    );
    clock = new Date(clock.getTime() + deps.handoff.ttlMs + 1);
    expect(await status(claude, late.pendingActionId)).toMatchObject({
      state: "expired",
      sentence: expect.stringContaining(ASK_EXPIRED_MESSAGE),
    });

    // Closed by a revoke — `expirePendingActionsForConnection` stamps both clocks and records no
    // answer — reads expired too, never declined: nobody said no (Greptile on #94). The row is
    // stamped as the repo stamps it, since a proposal's ask carries no connection id to revoke.
    const closed = cardOf(
      await claude.call("request_connection", {
        ...SECRET,
        vendor: "gamma",
        displayName: "Gamma",
        primaryHost: "https://api.gamma.example",
      }),
    );
    const row = store.pendingActions.get(closed.pendingActionId);
    if (!row) throw new Error("the ask was not stored");
    store.pendingActions.set(closed.pendingActionId, {
      ...row,
      expiresAt: clock,
      consumedAt: clock,
    });
    expect(await status(claude, closed.pendingActionId)).toMatchObject({
      state: "expired",
      sentence: expect.stringContaining(ASK_EXPIRED_MESSAGE),
    });
    const refused = await answer(claude, closed.pendingActionId, { decline: true });
    expect(refused.body).toMatchObject({ reason: "expired", message: ASK_EXPIRED_MESSAGE });
  });

  it("refuses ask_status under the card gate: a static-token agent, another agent's ask, no id", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const own = cardOf(await hermes.call("request_credential", { connectionId: CONN }));
    expect(await status(hermes, own.pendingActionId)).toMatchObject({
      reason: CARD_NOT_AVAILABLE,
    });
    const claude = await connect(TOKEN_CLAUDE);
    expect(await status(claude, own.pendingActionId)).toMatchObject({ reason: "ask_not_found" });
    expect(text(await claude.call(ASK_STATUS, {}))).toMatchObject({ reason: "input_invalid" });
  });
});

/**
 * The awaiting message under a rendered card (GRA-120; ADR 0006 as amended 2026-09-20). The same
 * ask reaches two kinds of client: one the server knows renders the card — the card gate's client
 * half, `card-client.ts` — and one it does not. For the first, `message` takes the card form and
 * `cardShown: true` rides beside `url`, in the text block the model reads and in
 * `structuredContent` alike; for the second, the result is byte for byte GRA-55's. `url`,
 * `reason`, `pendingActionId` and `expiresAt` are the same in both.
 */
describe("the awaiting message under a rendered card", () => {
  const CONSOLE_FORM = "Relay this link";

  /** The two forms, for the same `url` and `expiresAt`. */
  function expectCardForm(body: Record<string, unknown>) {
    expect(body.cardShown).toBe(true);
    expect(body.message).toContain(cardHandoffSentence(String(body.url), String(body.expiresAt)));
    expect(body.message).toContain("shown as a card in this conversation");
    expect(body.message).not.toContain(CONSOLE_FORM);
  }
  function expectConsoleForm(body: Record<string, unknown>) {
    expect(body).not.toHaveProperty("cardShown");
    expect(body.message).toContain(CONSOLE_FORM);
    expect(body.message).not.toContain("shown as a card");
  }

  it("a build ask: the console form for a static-token agent, the card form for a card-host OAuth agent, the rest of the answer the same", async () => {
    const hermes = await connect(TOKEN_HERMES);
    const claude = await connect(TOKEN_CLAUDE);
    const plain = await hermes.call("acquire", { connectionId: CONN, goal: "list orders" });
    const carded = await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    for (const result of [plain, carded]) expect(result.isError).toBe(false);

    const plainBody = text(plain);
    expectConsoleForm(plainBody);
    expect(plainBody.message).toContain("Graft needs the person's approval before");

    const cardedBody = text(carded);
    expectCardForm(cardedBody);
    // The lead — what is asked, what the answer will mean — is the same in both forms.
    expect(cardedBody.message).toContain("Graft needs the person's approval before");
    expect(cardedBody.message).toContain("Call again once they have answered");
    expect(cardedBody).toMatchObject({
      error: "awaiting_approval",
      reason: "awaiting_approval",
      url: expect.stringContaining(CONSOLE_URL),
      expiresAt: expect.any(String),
      pendingActionId: expect.any(String),
    });
    // Both blocks carry the flag; the card rides in `structuredContent` alone as before.
    const card = cardOf(carded);
    expect((carded.structuredContent as Record<string, unknown>).cardShown).toBe(true);
    expect(card.url).toBe(cardedBody.url);
    // The flag is not on the card's data: the card reads nothing from it.
    expect(card).not.toHaveProperty("cardShown");
  });

  it("an OAuth client nothing vouches for reads the console form, its own declaration of the extension included", async () => {
    const unknown = await connect(TOKEN_UNKNOWN);
    expectConsoleForm(text(await unknown.call("acquire", { connectionId: CONN, goal: "list" })));

    // The same verdict shapes the gate and the message (GRA-120), so an off-list client that
    // declares the extension reads the console form too, and is told the truth: no card is shown
    // to it (GRA-150).
    const declared = await connect(TOKEN_UNKNOWN, { declaresExtension: true });
    expectConsoleForm(text(await declared.call("acquire", { connectionId: CONN, goal: "list" })));

    // A static-token agent's session declaring the extension changes nothing either: the harness
    // holds the token, and the card renders for a chat product's agent alone.
    const hermes = await connect(TOKEN_HERMES, { declaresExtension: true });
    expectConsoleForm(text(await hermes.call("acquire", { connectionId: CONN, goal: "list" })));
  });

  it("a connection ask, a secret's connection ask, a credential ask and a scope ask take the card form too, their leads kept", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const keyless = text(await claude.call("request_connection", KEYLESS));
    expectCardForm(keyless);
    expect(keyless.message).toContain("the scheme takes no credential, so nothing is entered");
    expect(keyless.message).toContain("Call request_connection again with the same proposal");

    // A scheme with a secret: the card opens the console for the secret (GRA-118), so the ask is
    // still answered from the card, and the message says so in the same words.
    const secret = text(await claude.call("request_connection", SECRET));
    expectCardForm(secret);
    expect(secret.message).toContain("the secret never passes through you");

    const credential = text(await claude.call("request_credential", { connectionId: CONN }));
    expectCardForm(credential);
    expect(credential).toMatchObject({ reason: "awaiting_credential" });

    // A scope ask: a connection made for another agent (GRA-104).
    store.addConnection({
      id: "conn_scope",
      personId: PERSON,
      vendor: "delta",
      displayName: "Delta Books",
      primaryHost: "https://api.delta.example/v1",
      schemeConfig: { headerName: "x-delta-key" },
    });
    store.agentConnections.get(OTHER)?.add("conn_scope");
    const scope = text(
      await claude.call("request_connection", {
        vendor: "delta",
        displayName: "Delta Books",
        primaryHost: "https://api.delta.example/v1",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-delta-key" },
      }),
    );
    expect(scope).toMatchObject({ reason: "awaiting_scope", connectionId: "conn_scope" });
    expectCardForm(scope);

    // The same asks for a static-token agent: the console form, untouched.
    const hermes = await connect(TOKEN_HERMES);
    expectConsoleForm(text(await hermes.call("request_connection", KEYLESS)));
    expectConsoleForm(text(await hermes.call("request_credential", { connectionId: CONN })));
  });

  it("keeps the card and the card form when a sign-in host was set aside, with the set-aside sentence on both forms", async () => {
    // GRA-89's rebuild of the outcome dropped the card before this (Greptile on #96). Sign-in hosts
    // are the OAuth scheme's (`SIGN_IN_HOSTS` in `@graft/core`), so the proposal is Gmail's.
    const withSignIn = {
      vendor: "gmail",
      displayName: "Gmail",
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com", "accounts.google.com"],
      scheme: "oauth_authorization_code",
      schemeConfig: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
      },
    };
    const claude = await connect(TOKEN_CLAUDE);
    const carded = await claude.call("request_connection", withSignIn);
    const body = text(carded);
    expectCardForm(body);
    expect(body.hostsSetAside).toEqual(["accounts.google.com"]);
    expect(body.message).toContain("accounts.google.com is a sign-in endpoint and was set aside");
    expect(cardOf(carded)).toMatchObject({ kind: "connection", hosts: ["gmail.googleapis.com"] });

    // The OAuth lead's console relay reads "Then relay this link" (ADR 0005's guide), so the
    // console form is checked by that sentence rather than the shared helper.
    const hermes = await connect(TOKEN_HERMES);
    const plain = text(await hermes.call("request_connection", withSignIn));
    expect(plain).not.toHaveProperty("cardShown");
    expect(plain.message).toContain("Then relay this link so they can enter the client id");
    expect(plain.message).not.toContain("shown as a card");
    expect(plain.message).toContain("accounts.google.com is a sign-in endpoint and was set aside");
  });

  it("names no console in a keyless proposal's card-form lead: the card's button is the confirmation", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const keyless = text(await claude.call("request_connection", KEYLESS));
    expect(keyless.message).toMatch(
      /confirm the connection to Open-Meteo \(open-meteo\) — the scheme/,
    );
    expect(keyless.message).not.toContain("in the console — the scheme");
    const hermes = await connect(TOKEN_HERMES);
    expect(text(await hermes.call("request_connection", KEYLESS)).message).toContain(
      "confirm the connection to Open-Meteo (open-meteo) in the console",
    );
  });

  it("reads the client once per session: the client row is not re-read on every awaiting result", async () => {
    let clientReads = 0;
    const findMcpClient = deps.findMcpClient;
    deps.findMcpClient = async (db, clientId) => {
      clientReads += 1;
      return findMcpClient(db, clientId);
    };
    const claude = await connect(TOKEN_CLAUDE);
    await claude.call("acquire", { connectionId: CONN, goal: "list orders" });
    await claude.call("request_connection", KEYLESS);
    await claude.call("request_credential", { connectionId: CONN });
    expect(clientReads).toBe(1);
  });

  it("leaves a refusal alone: no card, no flag, an error as before", async () => {
    const claude = await connect(TOKEN_CLAUDE);
    const refused = await claude.call("acquire", { connectionId: "conn_missing", goal: "list" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatchObject({ error: "refused", reason: "connection_not_in_scope" });
    expect(text(refused)).not.toHaveProperty("cardShown");
    expect(refused.structuredContent).not.toHaveProperty("card");
  });
});
