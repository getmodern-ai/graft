import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RelayBudgetVerdict, RelayPlugin } from "@graft/proxy";
import { relayBudgetMessage } from "@graft/proxy/relay-budget";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NO_ELICITATION } from "./approval";
import type { McpDeps, ToolCallEvent } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier } from "./notifier";
import { relayBudgetSpent } from "./relay-budget-door";
import { runAuthoredTool } from "./run";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { authoredToolName } from "./tool-names";

/**
 * The relay budget at a run's door and inside a run (GRA-350; ADR 0019 as amended 2026-11-14).
 * Two connections, one that relays and one the proxy signs itself, each with a read-only tool on
 * it. The door is a peek the suite scripts; the proxy is the real one in front of a fake vendor,
 * with a relay budget the suite scripts too, so a refusal inside a run is the proxy's own 429 read
 * by the real runner in the fake sandbox. No database, no network.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const TOKEN = "grft_token_for_relay_budget_agent_000000000000";
const CONN_RELAYED = "conn_relayed";
const CONN_KEYED = "conn_keyed";
const SANDBOX = `agent-${AGENT}`;

const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch("/files");
  if (!res.ok) throw new Error(\`GET /files \${res.status}: \${await res.text()}\`);
  return await res.json();
};
`;

const RESETS_AT = new Date("2026-10-12T14:00:00Z");
const EXHAUSTED: RelayBudgetVerdict = {
  allowed: false,
  ceiling: "agent_hour",
  limit: 250,
  used: 250,
  resetsAt: RESETS_AT,
};
/** The proxy's sentence for `EXHAUSTED`, pinned: what the agent reads at the door and mid-run alike. */
const SENTENCE =
  "This agent has made 250 relayed calls this hour, its limit of 250 an hour; relayed calls resume at 2026-10-12 14:00 UTC. An agent that reaches this limit is usually calling the same tool in a loop: stop, and tell the person what you were doing.";

/** A relay that sends the vendor request to an upstream named by its one field. */
const relay: RelayPlugin = {
  kind: "relay",
  scheme: "relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay(target, fields) {
    target.url.href = `${fields.upstream}/relay?to=${encodeURIComponent(target.url.href)}`;
  },
  headerNames: () => [],
};

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
/** What the door's peek answers, and how often it was asked. */
let peekAnswer: RelayBudgetVerdict | Error;
let peeks: number;
/** What the proxy's budget answers each relayed call, and how often it was asked. */
let chargeAnswer: RelayBudgetVerdict;
let charges: number;
const toolEvents: ToolCallEvent[] = [];

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: CONN_KEYED,
        personId: PERSON,
        primaryHost: "https://api.keyed.example",
        credential: { apiKey: "keyed-key" },
      },
    ],
    resolve: async (id) =>
      id === CONN_RELAYED
        ? {
            id: CONN_RELAYED,
            personId: PERSON,
            authScheme: null,
            primaryHost: "https://www.drive.example/v3",
            hosts: ["www.drive.example"],
            schemeConfig: null,
            credentialCiphertext: null,
            relay: { plugin: relay, obtain: async () => ({ upstream: "https://relay.example" }) },
          }
        : null,
    relayBudget: {
      charge: async () => {
        charges += 1;
        return chargeAnswer;
      },
    },
    respond: () => Response.json({ files: ["sheet.xlsx"] }),
  });
  sandbox = createFakeSandboxBackend();

  for (const vendorSlug of ["drive", "keyed"]) {
    const dir = join(sandbox.toolboxRoot(PERSON), `tools/${vendorSlug}/list-files/v1`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), MODULE);
  }

  store = createFakeStore();
  store.addConnection({
    id: CONN_RELAYED,
    personId: PERSON,
    vendor: "drive",
    scheme: "relay",
    schemeConfig: {},
    primaryHost: "https://www.drive.example/v3",
  });
  store.addConnection({
    id: CONN_KEYED,
    personId: PERSON,
    vendor: "keyed",
    primaryHost: "https://api.keyed.example",
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT,
    personId: PERSON,
    token: TOKEN,
    connectionIds: [CONN_RELAYED, CONN_KEYED],
  });
  for (const [vendorSlug, connectionId] of [
    ["drive", CONN_RELAYED],
    ["keyed", CONN_KEYED],
  ] as const) {
    store.addTool({
      id: `tool_${vendorSlug}`,
      personId: PERSON,
      vendor: vendorSlug,
      name: "list-files",
      description: "List files.",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: connectionId,
      path: `tools/${vendorSlug}/list-files/v1`,
    });
    store.promote(AGENT, `tool_${vendorSlug}`);
  }

  deps = {
    ...createFakeDeps(store),
    inFlight: createInFlightRegistry(),
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: async () => {
      throw new Error("nothing is checked in this suite");
    },
    runnerFiles,
    skills: loadSkills,
    readWebPage: async () => {
      throw new Error("no network in this suite");
    },
    relayBudget: {
      peek: async () => {
        peeks += 1;
        if (peekAnswer instanceof Error) throw peekAnswer;
        return peekAnswer;
      },
    },
    onToolCall: (event) => toolEvents.push(event),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-mcp-test-handoff-secret-that-is-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
}, 30_000);

afterAll(async () => {
  deps.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

beforeEach(() => {
  peekAnswer = { allowed: true };
  peeks = 0;
  chargeAnswer = { allowed: true };
  charges = 0;
  toolEvents.length = 0;
});

const run = (vendorSlug: "drive" | "keyed", dryRun = false) =>
  runAuthoredTool(
    deps,
    { personId: PERSON, agentId: AGENT },
    {
      vendor: vendorSlug,
      name: "list-files",
      input: {},
      mode: { detached: false, timeoutSeconds: 30, dryRun },
      channel: NO_ELICITATION,
    },
  );

describe("the sentence", () => {
  it("is the proxy's, pinned", () => {
    expect(relayBudgetMessage(EXHAUSTED)).toBe(SENTENCE);
  });
});

describe("the door (GRA-350)", () => {
  it("refuses a run over a relayed connection past a ceiling before a sandbox is touched, with a refused ledger row", async () => {
    peekAnswer = EXHAUSTED;
    const execs = sandbox.processNames(SANDBOX).length;
    const usage = store.usage.length;
    const answer = await run("drive");
    expect(answer).toEqual({
      isError: true,
      answer: { error: "refused", reason: "relay_budget_exhausted", message: SENTENCE },
    });
    expect(peeks).toBe(1);
    expect(sandbox.processNames(SANDBOX)).toHaveLength(execs);
    expect(charges).toBe(0);
    expect(store.usage.slice(usage)).toEqual([
      expect.objectContaining({
        toolId: "tool_drive",
        outcome: "refused",
        reason: "relay_budget_exhausted",
        connectionId: CONN_RELAYED,
        dryRun: false,
      }),
    ]);
  });

  it("refuses a dry run alike, since its reads are relayed and counted", async () => {
    peekAnswer = EXHAUSTED;
    const execs = sandbox.processNames(SANDBOX).length;
    const answer = await run("drive", true);
    expect(answer.isError).toBe(true);
    expect(answer.answer).toMatchObject({ reason: "relay_budget_exhausted" });
    expect(sandbox.processNames(SANDBOX)).toHaveLength(execs);
  });

  it("lets a run over a connection the proxy signs itself go, past a ceiling or not, and never asks", async () => {
    peekAnswer = EXHAUSTED;
    const answer = await run("keyed");
    expect(answer).toEqual({ isError: false, answer: { files: ["sheet.xlsx"] } });
    expect(peeks).toBe(0);
  }, 30_000);

  it("lets a relayed run go when the budget has room, and the proxy charges each call that leaves", async () => {
    const answer = await run("drive");
    expect(answer).toEqual({ isError: false, answer: { files: ["sheet.xlsx"] } });
    expect(peeks).toBe(1);
    expect(charges).toBe(1);
  }, 30_000);

  it("fails open: a peek that throws lets the run go to the proxy, which still judges", async () => {
    peekAnswer = new Error("the count could not be read");
    const answer = await run("drive");
    expect(answer.isError).toBe(false);
    expect(charges).toBe(1);
  }, 30_000);

  it("asks nothing when the deployment set no ceiling", async () => {
    const { relayBudget: _unset, ...unbudgeted } = deps;
    const answer = await runAuthoredTool(
      unbudgeted,
      { personId: PERSON, agentId: AGENT },
      {
        vendor: "drive",
        name: "list-files",
        input: {},
        mode: { detached: false, timeoutSeconds: 30, dryRun: false },
        channel: NO_ELICITATION,
      },
    );
    expect(answer.isError).toBe(false);
    expect(peeks).toBe(0);
  }, 30_000);
});

describe("relayBudgetSpent", () => {
  it("reads no budget for a row it was not handed or one that does not relay", async () => {
    const budget = {
      peek: async () => {
        peeks += 1;
        return EXHAUSTED;
      },
    };
    const scope = { personId: PERSON, agentId: AGENT };
    expect(await relayBudgetSpent(budget, scope, null)).toBeNull();
    expect(await relayBudgetSpent(budget, scope, { scheme: "bearer" })).toBeNull();
    expect(peeks).toBe(0);
    expect(await relayBudgetSpent(budget, scope, { scheme: "gateway" })).toEqual({
      reason: "relay_budget_exhausted",
      message: SENTENCE,
    });
  });
});

describe("a refusal inside a run (GRA-350)", () => {
  /** The SDK's client over the in-memory pair, so the call's wide event is the one a harness causes. */
  async function connect() {
    const notifier = createToolListChangedNotifier({ windowMs: 300 });
    const session = await openAgentSession(deps, TOKEN, notifier);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.server.connect(serverTransport);
    const client = new Client({ name: "test-harness", version: "0.0.0" });
    await client.connect(clientTransport);
    return {
      call: async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as CallToolResult,
      close: async () => {
        await client.close();
        await session.close();
        notifier.close();
      },
    };
  }

  const body = (result: CallToolResult): Record<string, unknown> => {
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("no text content");
    return JSON.parse(first.text);
  };

  it("is the run's refusal with the proxy's sentence, not the module's error or a vendor status, and the event names it", async () => {
    // The door has room; the proxy, judging the call that leaves, has none (a ceiling crossed
    // between the peek and the call, or a run that fans out past it).
    chargeAnswer = EXHAUSTED;
    const requests = vendor.requests.length;
    const usage = store.usage.length;
    const a = await connect();
    try {
      for (const call of [
        () => a.call(authoredToolName("drive", "list-files"), {}),
        () => a.call("run_tool", { vendor: "drive", name: "list-files", input: {} }),
      ]) {
        const result = await call();
        expect(result.isError).toBe(true);
        expect(body(result)).toEqual({
          error: "refused",
          reason: "relay_budget_exhausted",
          message: SENTENCE,
        });
      }
    } finally {
      await a.close();
    }
    expect(peeks).toBe(2);
    expect(charges).toBe(2);
    // Nothing reached the vendor: the proxy refused before the relay's fields were assembled.
    expect(vendor.requests).toHaveLength(requests);
    expect(store.usage.slice(usage)).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "relay_budget_exhausted" }),
      expect.objectContaining({ outcome: "refused", reason: "relay_budget_exhausted" }),
    ]);
    expect(toolEvents.map(({ tool, outcome, reason }) => ({ tool, outcome, reason }))).toEqual([
      {
        tool: authoredToolName("drive", "list-files"),
        outcome: "refused",
        reason: "relay_budget_exhausted",
      },
      { tool: "run_tool", outcome: "refused", reason: "relay_budget_exhausted" },
    ]);
  }, 30_000);
});
