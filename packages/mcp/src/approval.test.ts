import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { answerPendingAction } from "@graft/core";
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

import { NO_ELICITATION, requireBuildApproval } from "./approval";
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
const TOKEN_A = "grft_approval_token_a_000000000000000000000000";
const TOKEN_B = "grft_approval_token_b_000000000000000000000000";
const TOKEN_C = "grft_approval_token_c_000000000000000000000000";
const TOKEN_D = "grft_approval_token_d_000000000000000000000000";
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

  store = createFakeStore();
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
  ] as const) {
    store.addAgent({ id, personId: PERSON, token, name, connectionIds: [CONN_DEMO] });
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
    for (const agent of [AGENT_A, AGENT_B, AGENT_C, AGENT_D]) store.promote(agent, tool.id);
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
});

type Elicitation = (request: ElicitRequest) => Promise<ElicitResult> | ElicitResult;

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
const answer = (id: string, said: { allow: boolean; relax?: boolean }) =>
  answerPendingAction({ db: deps.db }, { personId: PERSON }, id, said, deps.pendingAction);

const actionsOf = (agentId: string, kind: string) =>
  [...store.pendingActions.values()].filter((row) => row.agentId === agentId && row.kind === kind);

const approvalOf = (agentId: string, toolId: string) => store.approvals.get(`${agentId} ${toolId}`);

/** `awaiting_approval` as the agent reads it, with the pending action it names. */
function awaiting(result: CallToolResult): {
  answer: Record<string, unknown>;
  action: PendingActionRow;
} {
  expect(result.isError).toBe(true);
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
  it("shows readOnlyHint false on exactly the tools that ask, and destructiveHint on the one that asks every time", async () => {
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
        perCallRelaxed: false,
      });

      const third = await a.call(CREATE_ITEM, { limit: 3 });
      expect(body(third)).toEqual(VENDOR_BODY);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(1);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("a destructive tool asks on every call; an answer with relax makes the next calls silent", async () => {
    const a = await connect(TOKEN_A);
    try {
      const first = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(first.action.payload).toMatchObject({
        toolId: "tool_delete",
        annotations: { readOnlyHint: false, destructiveHint: true },
      });
      await answer(first.action.id, { allow: true });

      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(approvalOf(AGENT_A, "tool_delete")).toMatchObject({
        decision: "allow",
        perCallRelaxed: false,
      });

      // The yes was for one call; the next asks again, with a new action.
      const third = awaiting(await a.call(DELETE_ITEM, { limit: 1 }));
      expect(third.action.id).not.toBe(first.action.id);
      await answer(third.action.id, { allow: true, relax: true });

      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(approvalOf(AGENT_A, "tool_delete")?.perCallRelaxed).toBe(true);
      const actionsBefore = actionsOf(AGENT_A, "tool").length;
      expect(body(await a.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(actionsOf(AGENT_A, "tool")).toHaveLength(actionsBefore);
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
      expect(formOf(request).requestedSchema.properties).not.toHaveProperty("relax");

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

  it("decline records the refusal and the tool returns approval_declined; the next call is tool_denied", async () => {
    const c = await connect(TOKEN_C, async () => ({ action: "decline" }));
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

  it("a dismissed form records nothing, so the next call asks again", async () => {
    let dismiss = true;
    const c = await connect(TOKEN_C, async () =>
      dismiss ? { action: "cancel" } : { action: "accept", content: { allow: false } },
    );
    try {
      const dismissed = await c.call(DELETE_ITEM, { limit: 1 });
      expect(body(dismissed)).toMatchObject({ error: "refused", reason: "approval_declined" });
      expect(store.approvals.has(`${AGENT_C} tool_delete`)).toBe(false);

      dismiss = false;
      const declined = await c.call(DELETE_ITEM, { limit: 1 });
      expect(body(declined)).toMatchObject({ reason: "approval_declined" });
      expect(approvalOf(AGENT_C, "tool_delete")).toMatchObject({ decision: "deny" });
      expect(c.elicitations).toHaveLength(2);
    } finally {
      await c.close();
      store.approvals.delete(`${AGENT_C} tool_delete`);
    }
  });

  it("a destructive tool's form offers relax; accept with relax makes later calls silent", async () => {
    const c = await connect(TOKEN_C, accept({ allow: true, relax: true }));
    try {
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(formOf(c.elicitations[0]).requestedSchema).toMatchObject({
        properties: { allow: { type: "boolean" }, relax: { type: "boolean" } },
      });
      expect(c.elicitations[0]?.params.message).toContain("destructive");
      expect(approvalOf(AGENT_C, "tool_delete")).toMatchObject({
        decision: "allow",
        perCallRelaxed: true,
      });
      expect(body(await c.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(c.elicitations).toHaveLength(1);
    } finally {
      await c.close();
    }
  }, 60_000);

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
 * to the handoff; now the accept is the yes, and the field only carries a form client's no or `relax`.
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
        perCallRelaxed: false,
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

  it("on a destructive tool the empty accept allows this call only: no button relaxes, and the next call asks again", async () => {
    const d = await connect(TOKEN_D, button);
    try {
      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(d.elicitations[0]?.params.message).toContain("whichever way you allow it");
      expect(approvalOf(AGENT_D, "tool_delete")).toMatchObject({
        decision: "allow",
        perCallRelaxed: false,
      });

      expect(body(await d.call(DELETE_ITEM, { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(d.elicitations).toHaveLength(2);
      expect(approvalOf(AGENT_D, "tool_delete")?.perCallRelaxed).toBe(false);
    } finally {
      await d.close();
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
