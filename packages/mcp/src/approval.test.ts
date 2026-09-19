import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { answerPendingAction, revokeApproval, setAskEveryCall } from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  type ElicitRequest,
  type ElicitRequestFormParams,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AUTOMATIC_ANSWER_MS, NO_ELICITATION, requireBuildApproval } from "./approval";
import type { McpDeps } from "./deps";
import { HANDOFF_TOKEN_PARAM, verifyHandoff } from "./handoff";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { authoredToolName, executeToolName } from "./tool-names";

/**
 * ADR 0008 as a harness observes it (GRA-23), on the same fixture shape as `server.test.ts`: the
 * SDK's client over the in-memory pair, the real services over in-memory fakes, the fake sandbox,
 * a fake vendor behind the real proxy. What is asserted is what the agent and the person see — a
 * result, an `awaiting_approval` with a link, a refusal by its reason, a pending action or approval
 * row with the agent and the tool on it — never how the gate reached it.
 *
 * The handoff branch is exercised harder than the elicitation branch on purpose: OpenClaw advertises
 * no elicitation at all and Hermes's is optional, so the URL is the channel every launch harness
 * takes (ADR 0006), and the elicitation is the layer on top.
 */

const PERSON = "person_1";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const AGENT_C = "agent_c";
const AGENT_D = "agent_d";
const AGENT_E = "agent_e";
const AGENT_F = "agent_f";
const AGENT_G = "agent_g";
const TOKEN_A = "grft_approval_token_a_000000000000000000000000";
const TOKEN_B = "grft_approval_token_b_000000000000000000000000";
const TOKEN_C = "grft_approval_token_c_000000000000000000000000";
const TOKEN_D = "grft_approval_token_d_000000000000000000000000";
const TOKEN_E = "grft_approval_token_e_000000000000000000000000";
const TOKEN_F = "grft_approval_token_f_000000000000000000000000";
const TOKEN_G = "grft_approval_token_g_000000000000000000000000";
const CONN_DEMO = "conn_demo";
const CONSOLE_URL = "http://console.graft.test";
const SECRET = "graft-approval-test-handoff-secret-long-enough-32";
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };

/** The list-items module through the runner, as an execute command — the path as a sandbox sees it. */
const RUN_LIST_ITEMS = `echo '{}' | node /graft/runner.mjs ${sandboxPath("tools/demo/list-items/v1")}`;

const LIST_ITEMS = authoredToolName("demo", "list-items");
const CREATE_ITEM = authoredToolName("demo", "create-item");
const UPDATE_ITEM = authoredToolName("demo", "update-item");
const DELETE_ITEM = authoredToolName("demo", "delete-item");

/** One module for every tool: the gate is about annotations and rows, not about what the module does. */
const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch(\`/items?limit=\${input.limit ?? 5}\`);
  if (!res.ok) throw new Error(\`GET /items \${res.status}: \${await res.text()}\`);
  return await res.json();
};
`;

const TOOLS = [
  { id: "tool_list", name: "list-items", readOnly: true, destructive: false },
  { id: "tool_create", name: "create-item", readOnly: false, destructive: false },
  { id: "tool_update", name: "update-item", readOnly: false, destructive: false },
  { id: "tool_delete", name: "delete-item", readOnly: false, destructive: true },
] as const;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;

/**
 * The suite's clock: real time plus what a test adds. `deps.pendingAction.now()` is what the ask
 * measures an elicitation's round trip on (GRA-43), so a handler that moves the offset before it
 * answers is a slow answer without a sleep; `afterEach` puts it back. Real time underneath, not a
 * frozen instant, because the expiry test below needs an action to expire while a call waits.
 */
const clock = { offsetMs: 0 };

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: CONN_DEMO,
        personId: PERSON,
        primaryHost: "https://api.demo.example/v2",
        credential: { apiKey: "sk_live_the_real_vendor_key" },
      },
    ],
  });
  sandbox = createFakeSandboxBackend();
  for (const tool of TOOLS) {
    const dir = join(sandbox.toolboxRoot(PERSON), `tools/demo/${tool.name}/v1`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), MODULE);
  }

  store = createFakeStore({ now: () => new Date(Date.now() + clock.offsetMs) });
  store.addConnection({
    id: CONN_DEMO,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example/v2",
  });
  for (const [id, token, name] of [
    [AGENT_A, TOKEN_A, "laptop Hermes"],
    [AGENT_B, TOKEN_B, "server OpenClaw"],
    [AGENT_C, TOKEN_C, "elicitation Hermes"],
    [AGENT_D, TOKEN_D, "Discord Hermes"],
    [AGENT_E, TOKEN_E, "headless Claude Code"],
    [AGENT_F, TOKEN_F, "oneshot Hermes"],
    [AGENT_G, TOKEN_G, "Hermes at a terminal"],
  ] as const) {
    store.addAgent({
      scopeMode: "listed",
      id,
      personId: PERSON,
      token,
      name,
      connectionIds: [CONN_DEMO],
    });
  }
  for (const tool of TOOLS) {
    store.addTool({
      id: tool.id,
      personId: PERSON,
      vendor: "demo",
      name: tool.name,
      description: `${tool.name} at Demo Orders, in the model's words.`,
      inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      defaultConnectionId: CONN_DEMO,
      path: `tools/demo/${tool.name}/v1`,
    });
    for (const agent of [AGENT_A, AGENT_B, AGENT_C, AGENT_D, AGENT_E, AGENT_F, AGENT_G]) {
      store.promote(agent, tool.id);
    }
  }

  deps = {
    ...createFakeDeps(store),
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: async (input) => ({
      entry: input.entry,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    }),
    runnerFiles,
    skills: loadSkills,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    listChangedWindowMs: 300,
    handoff: { consoleUrl: CONSOLE_URL, secret: SECRET, waitMs: 0, ttlMs: 60_000, pollMs: 20 },
  };
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

afterEach(() => {
  deps.handoff.waitMs = 0;
  deps.handoff.ttlMs = 60_000;
  clock.offsetMs = 0;
});

type Elicitation = (request: ElicitRequest) => Promise<ElicitResult> | ElicitResult;

/**
 * A person at the card, reading it before pressing Deny: the clock moves by the threshold inside
 * the client's handler, so the decline is the person's and holds. A handler that answers `decline`
 * at once is a client answering for the person, and falls through to the handoff (the GRA-43 block
 * at the end).
 */
const personDeclines: Elicitation = async () => {
  clock.offsetMs += AUTOMATIC_ANSWER_MS;
  return { action: "decline" };
};

/** The form an elicitation carried — this server sends form mode only (ADR 0006). */
const formOf = (request: ElicitRequest | undefined): ElicitRequestFormParams =>
  request?.params as ElicitRequestFormParams;

/** A harness. With `elicitation`, the client advertises the capability and answers with the handler. */
async function connect(token: string, elicitation?: Elicitation) {
  const notifier = createToolListChangedNotifier({ windowMs: 300 });
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client(
    { name: "test-harness", version: "0.0.0" },
    { capabilities: elicitation ? { elicitation: {} } : {} },
  );
  const elicitations: ElicitRequest[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitations.push(request);
      return elicitation(request);
    });
  }
  await client.connect(clientTransport);
  return {
    client,
    elicitations,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

/** What the console does when the person answers — GRA-6's service, as the answer endpoint calls it. */
const answer = (id: string, said: { allow: boolean; askEveryCall?: boolean }) =>
  answerPendingAction({ db: deps.db }, { personId: PERSON }, id, said, deps.pendingAction);

/** The agent page's switch — the same service the `PUT /approvals/:toolId/ask-every-call` route calls. */
const askEveryCall = (agentId: string, toolId: string, on: boolean) =>
  setAskEveryCall({ db: deps.db }, { personId: PERSON, agentId }, toolId, on, deps.approval);

const actionsOf = (agentId: string, kind: string) =>
  [...store.pendingActions.values()].filter((row) => row.agentId === agentId && row.kind === kind);

const approvalOf = (agentId: string, toolId: string) => store.approvals.get(`${agentId} ${toolId}`);

/** `awaiting_approval` as the agent reads it, with the pending action it names — a result, not an error (GRA-112). */
function awaiting(result: CallToolResult): {
  answer: Record<string, unknown>;
  action: PendingActionRow;
} {
  expect(result.isError).toBe(false);
  const said = body(result);
  expect(said).toMatchObject({
    error: "awaiting_approval",
    reason: "awaiting_approval",
    pendingActionId: expect.any(String),
    url: expect.stringMatching(
      new RegExp(`^${CONSOLE_URL}/pending/[^?]+\\?${HANDOFF_TOKEN_PARAM}=`),
    ),
    expiresAt: expect.any(String),
    message: expect.stringContaining(said.url as string),
  });
  const action = store.pendingActions.get(said.pendingActionId as string);
  if (!action) throw new Error(`no pending action ${said.pendingActionId}`);
  expect(new Date(said.expiresAt as string)).toEqual(action.expiresAt);
  return { answer: said, action };
}

describe("the tool list carries the rule the gate applies", () => {
  it("shows readOnlyHint false on exactly the tools that ask, and destructiveHint on the one whose ask says so", async () => {
    const a = await connect(TOKEN_A);
    try {
      const { tools } = await a.client.listTools();
      const hints = Object.fromEntries(
        tools
          .filter((tool) => tool.name.startsWith("demo__"))
          .map((tool) => [tool.name, tool.annotations]),
      );
      expect(hints).toEqual({
        [LIST_ITEMS]: { readOnlyHint: true, destructiveHint: false },
        [CREATE_ITEM]: { readOnlyHint: false, destructiveHint: false },
        [UPDATE_ITEM]: { readOnlyHint: false, destructiveHint: false },
        [DELETE_ITEM]: { readOnlyHint: false, destructiveHint: true },
      });
    } finally {
      await a.close();
    }
  });
});

describe("through a handoff — the channel every harness has", () => {
  it("a read-only tool runs with no ask, no pending action and no approval row", async () => {
    const a = await connect(TOKEN_A);
    try {
      const result = await a.call(LIST_ITEMS, { limit: 1 });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);
      expect(store.pendingActions.size).toBe(0);
      expect(store.approvals.size).toBe(0);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("a write tool asks on the first call with a signed link and a durable row, and runs silently on the second once the person has answered", async () => {
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      const first = await a.call(CREATE_ITEM, { limit: 1 });
      const { answer: said, action } = awaiting(first);
      expect(vendor.requests).toHaveLength(requestsBefore);
      expect(action).toMatchObject({
        agentId: AGENT_A,
        kind: "tool",
        answeredAt: null,
        consumedAt: null,
        payload: {
          toolId: "tool_create",
          toolName: CREATE_ITEM,
          vendor: "demo",
          description: "create-item at Demo Orders, in the model's words.",
          annotations: { readOnlyHint: false, destructiveHint: false },
          connectionId: CONN_DEMO,
          connectionName: "Demo Orders",
          hosts: ["api.demo.example"],
          note: expect.stringContaining("agent's model"),
          askEveryCall: false,
        },
      });
      expect(store.usage.at(-1)).toMatchObject({
        agentId: AGENT_A,
        toolId: "tool_create",
        outcome: "refused",
      });
      // The link verifies against the row it names, and against nothing else.
      const token = new URL(said.url as string).searchParams.get(HANDOFF_TOKEN_PARAM);
      expect(verifyHandoff({ token, subject: action, secret: SECRET, now: new Date() })).toEqual({
        ok: true,
      });
      expect(
        verifyHandoff({
          token,
          subject: { ...action, agentId: AGENT_B },
          secret: SECRET,
          now: new Date(),
        }),
      ).toMatchObject({ reason: "tampered" });

      // Asking again while the answer is pending returns the same action, not a second one.
      const again = awaiting(await a.call(CREATE_ITEM, { limit: 1 }));
      expect(again.action.id).toBe(action.id);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(1);

      // The person answers from the console after the call has returned.
      await answer(action.id, { allow: true });

      const second = await a.call(CREATE_ITEM, { limit: 2 });
      expect(second.isError).toBeFalsy();
      expect(body(second)).toEqual(VENDOR_BODY);
      expect(vendor.requests.at(-1)?.url).toBe("https://api.demo.example/v2/items?limit=2");
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
      expect(approvalOf(AGENT_A, "tool_create")).toMatchObject({
        agentId: AGENT_A,
        toolId: "tool_create",
        decision: "allow",
        askEveryCall: false,
      });

      const third = await a.call(CREATE_ITEM, { limit: 3 });
      expect(body(third)).toEqual(VENDOR_BODY);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(1);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("a destructive tool asks once and the yes holds; set to ask every time it asks on each call until set back", async () => {
    const a = await connect(TOKEN_A);
    try {
      const first = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(first.action.payload).toMatchObject({
        toolId: "tool_delete",
        annotations: { readOnlyHint: false, destructiveHint: true },
        askEveryCall: false,
      });
      await answer(first.action.id, { allow: true });

      // The yes holds, as a write's does (ADR 0008, amendment of 2026-09-15): no new action.
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(approvalOf(AGENT_A, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });
      let actionsBefore = actionsOf(AGENT_A, "tool").length;
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(actionsBefore);

      // The person opts in from the agent's page: the next call asks, and the ask says so.
      await askEveryCall(AGENT_A, "tool_delete", true);
      const perCall = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(perCall.action.id).not.toBe(first.action.id);
      expect(perCall.action.payload).toMatchObject({ askEveryCall: true });
      // A yes that keeps the setting is for this call: the one after asks again, with a new action.
      await answer(perCall.action.id, { allow: true, askEveryCall: true });
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      const again = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(again.action.id).not.toBe(perCall.action.id);

      // Turning it off in the answer makes the yes hold again.
      await answer(again.action.id, { allow: true, askEveryCall: false });
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(approvalOf(AGENT_A, "tool_delete")?.askEveryCall).toBe(false);
      actionsBefore = actionsOf(AGENT_A, "tool").length;
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(actionsBefore);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("a per-call yes left waiting for the agent is spent when the person withdraws or changes the setting, so nothing re-creates the row", async () => {
    const a = await connect(TOKEN_A);
    const withdraw = () =>
      revokeApproval(
        { db: deps.db },
        { personId: PERSON, agentId: AGENT_A },
        "tool_delete",
        deps.approval,
      );
    try {
      // The setting on, a yes given in the console and not yet taken by the agent.
      await askEveryCall(AGENT_A, "tool_delete", true);
      const waiting = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      await answer(waiting.action.id, { allow: true, askEveryCall: true });

      // The person withdraws before the agent calls again: the yes goes with the row.
      await withdraw();
      expect(store.approvals.has(`${AGENT_A} tool_delete`)).toBe(false);
      expect(store.pendingActions.get(waiting.action.id)?.consumedAt).toBeInstanceOf(Date);
      const afresh = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(afresh.action.id).not.toBe(waiting.action.id);
      expect(store.approvals.has(`${AGENT_A} tool_delete`)).toBe(false);
      await answer(afresh.action.id, { allow: true });
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(approvalOf(AGENT_A, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });

      // The same for the setting: a yes given under "ask every time" does not outlive turning it off.
      await askEveryCall(AGENT_A, "tool_delete", true);
      const perCall = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      await answer(perCall.action.id, { allow: true, askEveryCall: true });
      await askEveryCall(AGENT_A, "tool_delete", false);
      expect(store.pendingActions.get(perCall.action.id)?.consumedAt).toBeInstanceOf(Date);
      // The row holds on its own now; the spent yes is not what lets this call through.
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      await withdraw();
      const again = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(again.action.id).not.toBe(perCall.action.id);
      expect(store.approvals.has(`${AGENT_A} tool_delete`)).toBe(false);
      await answer(again.action.id, { allow: true });
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("an answer inside the wait resumes the call that is waiting", async () => {
    deps.handoff.waitMs = 5_000;
    const b = await connect(TOKEN_B);
    try {
      const pending = b.call(CREATE_ITEM, { limit: 1 });
      await until(() => actionsOf(AGENT_B, "tool").some((row) => row.answeredAt === null));
      const action = actionsOf(AGENT_B, "tool").find((row) => row.answeredAt === null);
      if (!action) throw new Error("no open action");
      await answer(action.id, { allow: true });

      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
      expect(approvalOf(AGENT_B, "tool_create")?.decision).toBe("allow");
    } finally {
      await b.close();
    }
  }, 30_000);

  it("a decline recorded in the console refuses the waiting call as approval_declined, and holds as tool_denied after", async () => {
    const b = await connect(TOKEN_B);
    try {
      const first = awaiting(await b.call(UPDATE_ITEM, { limit: 1 }));
      await answer(first.action.id, { allow: false });

      const declined = await b.call(UPDATE_ITEM, { limit: 1 });
      expect(declined.isError).toBe(true);
      expect(body(declined)).toMatchObject({
        error: "refused",
        reason: "approval_declined",
        pendingActionId: first.action.id,
      });
      expect(approvalOf(AGENT_B, "tool_update")?.decision).toBe("deny");

      const denied = await b.call(UPDATE_ITEM, { limit: 1 });
      expect(body(denied)).toMatchObject({ error: "refused", reason: "tool_denied" });
      expect(store.usage.at(-1)).toMatchObject({ toolId: "tool_update", outcome: "refused" });
    } finally {
      await b.close();
    }
  });

  it("an action that expires while the call waits is a clear refusal, and is no longer answerable", async () => {
    deps.handoff.ttlMs = 40;
    deps.handoff.waitMs = 2_000;
    const b = await connect(TOKEN_B);
    try {
      const result = await b.call(DELETE_ITEM, { limit: 1 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        error: "refused",
        reason: "approval_expired",
        pendingActionId: expect.any(String),
      });
      const id = body(result).pendingActionId as string;
      await expect(answer(id, { allow: true })).rejects.toMatchObject({ code: "GONE" });
      expect(store.approvals.has(`${AGENT_B} tool_delete`)).toBe(false);

      // The next call asks afresh rather than reusing the expired record.
      deps.handoff.ttlMs = 60_000;
      const fresh = awaiting(await b.call(DELETE_ITEM, { limit: 1 }));
      expect(fresh.action.id).not.toBe(id);
    } finally {
      await b.close();
    }
  });

  it("run_tool takes the same path as the first-class tool, and a dry run passes without asking", async () => {
    const c = await connect(TOKEN_C);
    try {
      const viaRunTool = await c.call("run_tool", { vendor: "demo", name: "create-item" });
      awaiting(viaRunTool);

      const dry = await c.call("run_tool", { vendor: "demo", name: "delete-item", dryRun: true });
      expect(dry.isError).toBeFalsy();
      expect(body(dry).dryRun).toMatchObject({ dryRun: true, passed: true });
      expect(actionsOf(AGENT_C, "tool").map((row) => row.payload.toolId)).toEqual(["tool_create"]);
    } finally {
      await c.close();
      store.pendingActions.clear();
    }
  }, 30_000);
});

describe("the build approval", () => {
  it("execute__<connection> asks once per agent through a handoff, then runs; a second agent asks again", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    const command = RUN_LIST_ITEMS;
    try {
      const first = awaiting(await a.call(executeToolName(CONN_DEMO), { command }));
      expect(first.action).toMatchObject({
        agentId: AGENT_A,
        kind: "build",
        payload: {
          connectionId: CONN_DEMO,
          vendor: "demo",
          connectionName: "Demo Orders",
          hosts: ["api.demo.example"],
        },
      });
      expect(store.usage.at(-1)).toMatchObject({
        toolName: executeToolName(CONN_DEMO),
        outcome: "refused",
      });
      await answer(first.action.id, { allow: true });

      const ran = body(await a.call(executeToolName(CONN_DEMO), { command }));
      expect(ran.exitCode).toBe(0);
      expect(ran.output).toContain(JSON.stringify(VENDOR_BODY));
      expect(store.buildApprovals.get(`${AGENT_A} ${CONN_DEMO}`)).toMatchObject({
        agentId: AGENT_A,
        connectionId: CONN_DEMO,
      });
      const actionsBefore = actionsOf(AGENT_A, "build").length;
      expect(body(await a.call(executeToolName(CONN_DEMO), { command })).exitCode).toBe(0);
      expect(actionsOf(AGENT_A, "build")).toHaveLength(actionsBefore);

      // Per agent: B holds the same connection in scope and has to be asked for itself.
      const theirs = awaiting(await b.call(executeToolName(CONN_DEMO), { command }));
      expect(theirs.action.agentId).toBe(AGENT_B);
      expect(store.buildApprovals.has(`${AGENT_B} ${CONN_DEMO}`)).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("a declined build ask writes nothing, so the next call asks again", async () => {
    const b = await connect(TOKEN_B);
    try {
      const open = actionsOf(AGENT_B, "build").find((row) => row.answeredAt === null);
      if (!open) throw new Error("expected B's open build ask from the previous test");
      await answer(open.id, { allow: false });
      const declined = await b.call(executeToolName(CONN_DEMO), { command: "echo hi" });
      expect(body(declined)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(store.buildApprovals.has(`${AGENT_B} ${CONN_DEMO}`)).toBe(false);
      const again = awaiting(await b.call(executeToolName(CONN_DEMO), { command: "echo hi" }));
      expect(again.action.id).not.toBe(open.id);
    } finally {
      await b.close();
    }
  });

  it("requireBuildApproval passes without an ask once the row stands — what acquire will call", async () => {
    const ctx = { db: deps.db };
    const actions = store.pendingActions.size;
    await expect(
      requireBuildApproval(
        ctx,
        { personId: PERSON, agentId: AGENT_A },
        CONN_DEMO,
        deps,
        NO_ELICITATION,
      ),
    ).resolves.toEqual({ pass: true });
    expect(store.pendingActions.size).toBe(actions);

    const asked = await requireBuildApproval(
      ctx,
      { personId: PERSON, agentId: AGENT_C },
      CONN_DEMO,
      deps,
      NO_ELICITATION,
    );
    expect(asked).toMatchObject({ pass: false, answer: { error: "awaiting_approval" } });
    expect(store.pendingActions.size).toBe(actions + 1);
  });
});

describe("through an elicitation — where the client advertised one", () => {
  const accept =
    (content: Record<string, boolean>): Elicitation =>
    async () => ({
      action: "accept",
      content,
    });

  it("the ask arrives as a form naming the agent, the tool, the vendor and whose words the description is; accept records the approval and the call proceeds", async () => {
    const c = await connect(TOKEN_C, accept({ allow: true }));
    try {
      const result = await c.call(CREATE_ITEM, { limit: 1 });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);

      expect(c.elicitations).toHaveLength(1);
      const request = c.elicitations[0];
      expect(request?.params.mode ?? "form").toBe("form");
      const message = request?.params.message ?? "";
      for (const named of [
        "elicitation Hermes",
        CREATE_ITEM,
        "Demo Orders",
        "demo",
        "model's own words",
        "create-item at Demo Orders, in the model's words.",
      ]) {
        expect(message).toContain(named);
      }
      expect(formOf(request).requestedSchema).toMatchObject({
        type: "object",
        properties: { allow: { type: "boolean" } },
      });
      expect(formOf(request).requestedSchema.required ?? []).not.toContain("allow");
      // A write's form offers the opt-in too — the setting is per tool, not per annotation.
      expect(formOf(request).requestedSchema.properties.askEveryCall).toMatchObject({
        type: "boolean",
        default: false,
      });
      expect(message).toContain("Your answer holds for this agent from now on.");

      expect(approvalOf(AGENT_C, "tool_create")).toMatchObject({ decision: "allow" });
      expect(actionsOf(AGENT_C, "tool").filter((r) => r.payload.toolId === "tool_create")).toEqual(
        [],
      );

      // The answer holds: the second call asks nobody.
      expect(body(await c.call(CREATE_ITEM, { limit: 2 }))).toEqual(VENDOR_BODY);
      expect(c.elicitations).toHaveLength(1);
    } finally {
      await c.close();
    }
  }, 60_000);

  /**
   * A revoke while the form is open (GRA-69, found by review on #83): the revoke deletes every
   * approval for the connection, and the yes arriving after it must not write one back that would
   * stand once the connection is reconnected. The elicit below revokes the connection before it
   * answers, as a person with the console in one window and the harness in another can.
   */
  it("an accept after the connection was revoked mid-form records nothing and refuses connection_revoked, for a tool ask and for the build ask", async () => {
    const TOKEN_H = "grft_approval_token_h_000000000000000000000000";
    store.addAgent({
      scopeMode: "listed",
      id: "agent_h",
      personId: PERSON,
      token: TOKEN_H,
      connectionIds: [CONN_DEMO],
    });
    store.promote("agent_h", "tool_create");
    const live = store.connections.get(CONN_DEMO);
    if (!live) throw new Error("fixture: the connection is missing");
    const revokeThenAccept: Elicitation = async () => {
      store.connections.set(CONN_DEMO, { ...live, revokedAt: new Date() });
      return { action: "accept", content: { allow: true } };
    };
    const h = await connect(TOKEN_H, revokeThenAccept);
    try {
      const result = await h.call(CREATE_ITEM, { limit: 1 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
        connectionId: CONN_DEMO,
      });
      expect(h.elicitations).toHaveLength(1);
      expect(approvalOf("agent_h", "tool_create")).toBeUndefined();
      expect(actionsOf("agent_h", "tool")).toEqual([]);

      // The same across the build ask: the form is answered yes, the connection is gone, no row.
      store.connections.set(CONN_DEMO, live);
      const build = await h.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS });
      expect(build.isError).toBe(true);
      expect(body(build)).toMatchObject({ error: "refused", reason: "connection_revoked" });
      expect(h.elicitations).toHaveLength(2);
      expect(store.buildApprovals.get(`agent_h ${CONN_DEMO}`)).toBeUndefined();
      expect(actionsOf("agent_h", "build")).toEqual([]);
    } finally {
      store.connections.set(CONN_DEMO, live);
      await h.close();
    }
  }, 60_000);

  it("decline records the refusal and the tool returns approval_declined; the next call is tool_denied", async () => {
    const c = await connect(TOKEN_C, personDeclines);
    try {
      const result = await c.call(UPDATE_ITEM, { limit: 1 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(approvalOf(AGENT_C, "tool_update")).toMatchObject({ decision: "deny" });

      const denied = await c.call(UPDATE_ITEM, { limit: 1 });
      expect(body(denied)).toMatchObject({ error: "refused", reason: "tool_denied" });
      expect(c.elicitations).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it("a destructive tool's form names it destructive and offers ask-every-call; on, the next call asks again; off, the yes holds", async () => {
    let content: Record<string, boolean> = { allow: true, askEveryCall: true };
    const c = await connect(TOKEN_C, async () => ({ action: "accept", content }));
    try {
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(formOf(c.elicitations[0]).requestedSchema).toMatchObject({
        properties: {
          allow: { type: "boolean" },
          askEveryCall: { type: "boolean", title: "Ask every time for this tool", default: false },
        },
      });
      const message = c.elicitations[0]?.params.message ?? "";
      expect(message).toContain("This tool is destructive");
      expect(message).toContain("Your answer holds for this agent from now on.");
      expect(message).toContain("Ask every time for this tool");
      expect(approvalOf(AGENT_C, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: true,
      });

      // On: the second call asks again, and the form's default and message now say the setting is on.
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(c.elicitations).toHaveLength(2);
      expect(formOf(c.elicitations[1]).requestedSchema.properties.askEveryCall).toMatchObject({
        default: true,
      });
      expect(c.elicitations[1]?.params.message).toContain("this answer is for this call only");

      // Off, from the form: the yes holds and the fourth call asks nobody.
      content = { allow: true, askEveryCall: false };
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(c.elicitations).toHaveLength(3);
      expect(approvalOf(AGENT_C, "tool_delete")?.askEveryCall).toBe(false);
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(c.elicitations).toHaveLength(3);
    } finally {
      await c.close();
    }
  }, 60_000);

  it("the build ask's decline refuses and grants nothing, so the next call asks again", async () => {
    const c = await connect(TOKEN_C, personDeclines);
    // An earlier test left C an open build action from `requireBuildApproval`; none may be added here.
    const actionsBefore = actionsOf(AGENT_C, "build").length;
    try {
      const declined = await c.call(executeToolName(CONN_DEMO), { command: "echo hi" });
      expect(declined.isError).toBe(true);
      expect(body(declined)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(store.buildApprovals.has(`${AGENT_C} ${CONN_DEMO}`)).toBe(false);
      // No deny row for a build (the header): the next call asks afresh, and the person says no again.
      const again = await c.call(executeToolName(CONN_DEMO), { command: "echo hi" });
      expect(body(again)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(c.elicitations).toHaveLength(2);
      expect(actionsOf(AGENT_C, "build")).toHaveLength(actionsBefore);
    } finally {
      await c.close();
    }
  });

  it("the build ask is an elicitation too, and its accept grants the build approval", async () => {
    store.pendingActions.clear();
    const c = await connect(TOKEN_C, accept({ allow: true }));
    try {
      const ran = body(await c.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }));
      expect(ran.exitCode).toBe(0);
      expect(c.elicitations).toHaveLength(1);
      expect(c.elicitations[0]?.params.message).toContain("Demo Orders");
      expect(c.elicitations[0]?.params.message).toContain("elicitation Hermes");
      expect(store.buildApprovals.has(`${AGENT_C} ${CONN_DEMO}`)).toBe(true);
      expect(store.pendingActions.size).toBe(0);
    } finally {
      await c.close();
    }
  }, 30_000);
});

/**
 * Hermes 0.21.1 renders the form as its own approval card and answers every allow button — once,
 * session, always — with `accept` and empty content (GRA-42). A required `allow` sent each of those
 * to the handoff; now the accept is the yes, and the fields only carry a form client's no or its
 * `askEveryCall`. Every allow button is therefore a standing allow, on a destructive tool as on a
 * write (ADR 0008, amendment of 2026-09-15), and none touches the ask-every-call setting.
 */
describe("through an elicitation answered with no fields — Hermes 0.21.1's approval buttons", () => {
  const button: Elicitation = async () => ({ action: "accept", content: {} });

  it("on a write tool the empty accept passes the gate, records allow, and holds", async () => {
    const d = await connect(TOKEN_D, button);
    try {
      const result = await d.call(CREATE_ITEM, { limit: 1 });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);
      expect(d.elicitations).toHaveLength(1);
      const schema = formOf(d.elicitations[0]).requestedSchema;
      expect(schema.required ?? []).not.toContain("allow");
      expect(schema.properties.allow?.description).toContain("counts as allow");
      expect(approvalOf(AGENT_D, "tool_create")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });
      expect(actionsOf(AGENT_D, "tool")).toEqual([]);

      // Hermes said "once"; ADR 0008 says a write tool's yes holds, so the second call asks nobody.
      expect(body(await d.call(CREATE_ITEM, { limit: 2 }))).toEqual(VENDOR_BODY);
      expect(d.elicitations).toHaveLength(1);
    } finally {
      await d.close();
    }
  }, 60_000);

  it("an accept that says allow: false is still the no — recorded, and holding as tool_denied", async () => {
    const d = await connect(TOKEN_D, async () => ({ action: "accept", content: { allow: false } }));
    try {
      const result = await d.call(UPDATE_ITEM, { limit: 1 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(approvalOf(AGENT_D, "tool_update")).toMatchObject({ decision: "deny" });
      expect(body(await d.call(UPDATE_ITEM, { limit: 1 }))).toMatchObject({
        reason: "tool_denied",
      });
      expect(d.elicitations).toHaveLength(1);
    } finally {
      await d.close();
    }
  });

  it("on a destructive tool the empty accept records a standing allow, like Always Allow says, and the next call asks nobody", async () => {
    const d = await connect(TOKEN_D, button);
    try {
      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      const message = d.elicitations[0]?.params.message ?? "";
      expect(message).toContain("This tool is destructive");
      expect(message).toContain("Your answer holds for this agent from now on.");
      expect(message).toContain("in the console");
      expect(approvalOf(AGENT_D, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });

      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(d.elicitations).toHaveLength(1);
      expect(approvalOf(AGENT_D, "tool_delete")?.askEveryCall).toBe(false);

      // With the opt-in on, the button comes back on every call and each press is that call's yes,
      // and no press turns the setting off — that is the console's, which the message names.
      await askEveryCall(AGENT_D, "tool_delete", true);
      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(d.elicitations).toHaveLength(3);
      expect(d.elicitations[2]?.params.message).toContain("this answer is for this call only");
      expect(approvalOf(AGENT_D, "tool_delete")?.askEveryCall).toBe(true);
    } finally {
      await d.close();
      // The mismatch case below needs a tool D has not answered.
      store.approvals.delete(`${AGENT_D} tool_delete`);
    }
  }, 60_000);

  it("on the build ask the empty accept grants the build approval", async () => {
    const d = await connect(TOKEN_D, button);
    try {
      const ran = body(await d.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }));
      expect(ran.exitCode).toBe(0);
      expect(d.elicitations).toHaveLength(1);
      expect(store.buildApprovals.has(`${AGENT_D} ${CONN_DEMO}`)).toBe(true);
      expect(actionsOf(AGENT_D, "build")).toEqual([]);
    } finally {
      await d.close();
    }
  }, 30_000);

  it("any other mismatch with the form still falls back to the handoff and records nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await connect(TOKEN_D, async () => ({ action: "accept", content: { allow: "yes" } }));
    try {
      const before = approvalOf(AGENT_D, "tool_delete");
      const { action } = awaiting(await d.call(DELETE_ITEM, { limit: 1 }));
      expect(action).toMatchObject({ agentId: AGENT_D, kind: "tool", answeredAt: null });
      expect(d.elicitations).toHaveLength(1);
      expect(approvalOf(AGENT_D, "tool_delete")).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to a handoff"),
        expect.objectContaining({ message: expect.stringContaining("requested schema") }),
      );
    } finally {
      warn.mockRestore();
      await d.close();
      for (const row of actionsOf(AGENT_D, "tool")) store.pendingActions.delete(row.id);
    }
  }, 30_000);
});

/**
 * Claude Code in non-interactive mode (`claude -p`) advertises `elicitation` in `initialize` and
 * answers every form `cancel` without showing it (GRA-54's live check). Under the earlier rule a
 * cancel recorded nothing and the ask repeated, so the person never received a link from such a
 * client; now a cancel falls through to the handoff, per ask (ADR 0006, amendment of 2026-09-16).
 * What the agent gets is what a client with no elicitation gets — the same `awaiting_approval`, the
 * same durable row — and `decline` keeps its meaning. A console answer waiting for the ask is taken
 * before any form is offered, so the call after the console's answer asks nobody.
 */
describe("through an elicitation the client cancels without showing it — Claude Code's non-interactive mode", () => {
  const cancel: Elicitation = async () => ({ action: "cancel" });

  it("on a tool ask the cancel yields the handoff link and a pending action, records nothing, and the call after the console's answer runs", async () => {
    const e = await connect(TOKEN_E, cancel);
    try {
      const { answer: said, action } = awaiting(await e.call(DELETE_ITEM, { limit: 1 }));
      expect(e.elicitations).toHaveLength(1);
      expect(action).toMatchObject({
        agentId: AGENT_E,
        kind: "tool",
        answeredAt: null,
        payload: { toolId: "tool_delete", askEveryCall: false },
      });
      expect(store.approvals.has(`${AGENT_E} tool_delete`)).toBe(false);
      // The message is the handoff's, as a client with no elicitation would read it.
      expect(said.message).toContain("Relay this link");

      // Per ask, not per session: the next call offers the form again, and the same cancel reaches
      // the same open action rather than a second one.
      const again = awaiting(await e.call(DELETE_ITEM, { limit: 1 }));
      expect(again.action.id).toBe(action.id);
      expect(e.elicitations).toHaveLength(2);
      expect(actionsOf(AGENT_E, "tool")).toHaveLength(1);

      // The person answers from the console; the next call takes that answer before offering any
      // form, and runs.
      await answer(action.id, { allow: true });
      expect(body(await e.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(e.elicitations).toHaveLength(2);
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
      expect(approvalOf(AGENT_E, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });

      // The yes holds: no form, no new action.
      expect(body(await e.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(e.elicitations).toHaveLength(2);
      expect(actionsOf(AGENT_E, "tool")).toHaveLength(1);
    } finally {
      await e.close();
    }
  }, 60_000);

  it("on the build ask the cancel yields the handoff link and a pending action, grants nothing, and the call after the console's answer runs", async () => {
    const e = await connect(TOKEN_E, cancel);
    try {
      const { action } = awaiting(
        await e.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }),
      );
      expect(e.elicitations).toHaveLength(1);
      expect(action).toMatchObject({
        agentId: AGENT_E,
        kind: "build",
        answeredAt: null,
        payload: { connectionId: CONN_DEMO, vendor: "demo", connectionName: "Demo Orders" },
      });
      expect(store.buildApprovals.has(`${AGENT_E} ${CONN_DEMO}`)).toBe(false);
      expect(store.usage.at(-1)).toMatchObject({
        toolName: executeToolName(CONN_DEMO),
        outcome: "refused",
      });

      await answer(action.id, { allow: true });
      const ran = body(await e.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }));
      expect(ran.exitCode).toBe(0);
      expect(ran.output).toContain(JSON.stringify(VENDOR_BODY));
      expect(e.elicitations).toHaveLength(1);
      expect(store.buildApprovals.has(`${AGENT_E} ${CONN_DEMO}`)).toBe(true);
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
    } finally {
      await e.close();
    }
  }, 60_000);

  it("a per-call yes waiting from the console is taken before any form is offered, so a form's answer cannot overtake it and leave it for a later call", async () => {
    let said: ElicitResult = { action: "cancel" };
    const e = await connect(TOKEN_E, async () => said);
    try {
      const { action } = awaiting(await e.call(UPDATE_ITEM, { limit: 1 }));
      expect(e.elicitations).toHaveLength(1);
      // The console says yes for one call and turns ask-every-call on; that yes waits for the agent.
      await answer(action.id, { allow: true, askEveryCall: true });
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeNull();

      // The client would answer the form itself now; it is offered none, the console's yes is taken.
      said = { action: "accept", content: { allow: true } };
      expect(body(await e.call(UPDATE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(e.elicitations).toHaveLength(1);
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
      expect(approvalOf(AGENT_E, "tool_update")).toMatchObject({
        decision: "allow",
        askEveryCall: true,
      });

      // Nothing waits any more: the per-call ask goes to the form, and no new action is created.
      expect(body(await e.call(UPDATE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(e.elicitations).toHaveLength(2);
      expect(
        actionsOf(AGENT_E, "tool").filter((row) => row.payload.toolId === "tool_update"),
      ).toHaveLength(1);
    } finally {
      await e.close();
    }
  }, 60_000);
});

/**
 * Hermes 0.21.1 answers `decline` in two situations that are not a person's choice: when its own
 * approval surface fails inside (a gateway without a `notify_cb`), and when it runs with no terminal
 * (`hermes chat --oneshot`) and takes its default, Deny. On GRA-35's Docker leg Graft's build ask was
 * declined twice within a second of being asked, `acquire` was refused with no link, and on a write
 * tool the same reflex would have held a `deny` nobody chose (GRA-43). So a decline that comes back
 * faster than a person could read the prompt is read as a dismissal and falls through to the
 * handoff as a cancel does (ADR 0006, amendment of 2026-09-18); one at or past `AUTOMATIC_ANSWER_MS`
 * is the person's and holds as before; an accept is taken at any speed. The round trip is measured
 * on the suite's clock, which `personDeclines` moves, and rides the log line beside `automatic`.
 */
describe("through an elicitation the client declines on its own — Hermes with no terminal, or its approval surface failing", () => {
  const declinesAtOnce: Elicitation = async () => ({ action: "decline" });

  /** The one line per elicitation and the fields GRA-43 puts beside the outcome. */
  type ElicitationEvent = { action: string; roundTripMs: number; automatic: boolean };
  const eventsOf = (info: { mock: { calls: unknown[][] } }): ElicitationEvent[] =>
    info.mock.calls
      .filter(([line]) => typeof line === "string" && line.startsWith("mcp: elicitation "))
      .map(([, event]) => event as ElicitationEvent);

  it("on the build ask an instant decline yields the handoff link and a pending action, grants nothing, says the client answered on its own, and the call after the console's answer runs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await connect(TOKEN_F, declinesAtOnce);
    try {
      const { answer: said, action } = awaiting(
        await f.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }),
      );
      expect(f.elicitations).toHaveLength(1);
      expect(action).toMatchObject({
        agentId: AGENT_F,
        kind: "build",
        answeredAt: null,
        payload: { connectionId: CONN_DEMO, vendor: "demo", connectionName: "Demo Orders" },
      });
      expect(store.buildApprovals.has(`${AGENT_F} ${CONN_DEMO}`)).toBe(false);
      // The message names what happened, then carries the handoff as any client without forms reads it.
      expect(said.message).toContain("Your client answered the approval prompt on its own");
      expect(said.message).toContain("the person can answer in the console");
      expect(said.message).toContain("Relay this link");
      // The wide event: the outcome, the round trip, and that the rule fired.
      expect(eventsOf(info)).toEqual([
        { action: "decline", roundTripMs: expect.any(Number), automatic: true },
      ]);
      expect(eventsOf(info)[0]?.roundTripMs).toBeLessThan(AUTOMATIC_ANSWER_MS);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("declined by the client on its own"),
        expect.anything(),
      );
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("falling back to a handoff"),
        expect.anything(),
      );

      // The person answers from the console; the next call takes that answer before offering any
      // form, and runs.
      await answer(action.id, { allow: true });
      const ran = body(await f.call(executeToolName(CONN_DEMO), { command: RUN_LIST_ITEMS }));
      expect(ran.exitCode).toBe(0);
      expect(f.elicitations).toHaveLength(1);
      expect(store.buildApprovals.has(`${AGENT_F} ${CONN_DEMO}`)).toBe(true);
      expect(store.pendingActions.get(action.id)?.consumedAt).toBeInstanceOf(Date);
    } finally {
      info.mockRestore();
      await f.close();
    }
  }, 60_000);

  it("on the build ask a decline past the threshold is the person's: refused, nothing granted, no pending action, and the event says the rule did not fire", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const g = await connect(TOKEN_G, personDeclines);
    const actionsBefore = actionsOf(AGENT_G, "build").length;
    try {
      const declined = await g.call(executeToolName(CONN_DEMO), { command: "echo hi" });
      expect(declined.isError).toBe(true);
      expect(body(declined)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(body(declined).message).not.toContain("on its own");
      expect(store.buildApprovals.has(`${AGENT_G} ${CONN_DEMO}`)).toBe(false);
      expect(actionsOf(AGENT_G, "build")).toHaveLength(actionsBefore);
      const [event] = eventsOf(info);
      expect(event).toMatchObject({ action: "decline", automatic: false });
      expect(event?.roundTripMs).toBeGreaterThanOrEqual(AUTOMATIC_ANSWER_MS);
      expect(info).not.toHaveBeenCalledWith(
        expect.stringContaining("falling back to a handoff"),
        expect.anything(),
      );
    } finally {
      info.mockRestore();
      await g.close();
    }
  });

  it("on a write tool's first ask an instant decline yields the handoff link and no deny row; the form is offered again per ask, and the console's yes runs the call", async () => {
    const f = await connect(TOKEN_F, declinesAtOnce);
    try {
      const { answer: said, action } = awaiting(await f.call(CREATE_ITEM, { limit: 1 }));
      expect(f.elicitations).toHaveLength(1);
      expect(action).toMatchObject({
        agentId: AGENT_F,
        kind: "tool",
        answeredAt: null,
        payload: { toolId: "tool_create", askEveryCall: false },
      });
      expect(store.approvals.has(`${AGENT_F} tool_create`)).toBe(false);
      expect(said.message).toContain("Your client answered the approval prompt on its own");

      // Per ask, not per session: the next call offers the form again, the same instant decline
      // reaches the same open action, and still nothing is recorded against the tool.
      const again = awaiting(await f.call(CREATE_ITEM, { limit: 1 }));
      expect(again.action.id).toBe(action.id);
      expect(f.elicitations).toHaveLength(2);
      expect(store.approvals.has(`${AGENT_F} tool_create`)).toBe(false);

      await answer(action.id, { allow: true });
      expect(body(await f.call(CREATE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(f.elicitations).toHaveLength(2);
      expect(approvalOf(AGENT_F, "tool_create")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });
    } finally {
      await f.close();
    }
  }, 60_000);

  it("on a write tool's first ask a decline past the threshold records deny, refuses approval_declined, and holds as tool_denied, as today", async () => {
    const g = await connect(TOKEN_G, personDeclines);
    try {
      const result = await g.call(UPDATE_ITEM, { limit: 1 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(approvalOf(AGENT_G, "tool_update")).toMatchObject({ decision: "deny" });
      expect(body(await g.call(UPDATE_ITEM, { limit: 1 }))).toMatchObject({
        error: "refused",
        reason: "tool_denied",
      });
      expect(g.elicitations).toHaveLength(1);
      expect(actionsOf(AGENT_G, "tool")).toEqual([]);
    } finally {
      await g.close();
    }
  });

  it("an instant accept is still the yes: the tool runs, the allow holds, and the event says the rule did not fire", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await connect(TOKEN_F, async () => ({ action: "accept", content: {} }));
    try {
      expect(body(await f.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(f.elicitations).toHaveLength(1);
      expect(approvalOf(AGENT_F, "tool_delete")).toMatchObject({
        decision: "allow",
        askEveryCall: false,
      });
      expect(
        actionsOf(AGENT_F, "tool").filter((row) => row.payload.toolId === "tool_delete"),
      ).toEqual([]);
      const [event] = eventsOf(info);
      expect(event).toMatchObject({ action: "accept", automatic: false });
      expect(event?.roundTripMs).toBeLessThan(AUTOMATIC_ANSWER_MS);

      expect(body(await f.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(f.elicitations).toHaveLength(1);
    } finally {
      info.mockRestore();
      await f.close();
    }
  }, 60_000);
});

describe("every approval and every pending action is a row with the agent and the tool or connection", () => {
  it("as the fake store holds them", () => {
    for (const row of store.approvals.values()) {
      expect(row.agentId).toMatch(/^agent_/);
      expect(TOOLS.map((tool) => tool.id)).toContain(row.toolId);
    }
    for (const row of store.buildApprovals.values()) {
      expect(row).toMatchObject({
        agentId: expect.stringMatching(/^agent_/),
        connectionId: CONN_DEMO,
      });
    }
    expect(store.approvals.size).toBeGreaterThan(0);
    expect(store.buildApprovals.size).toBeGreaterThan(0);
  });
});
