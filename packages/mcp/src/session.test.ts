import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ConnectionOutput } from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { ASK_CARD_MIME_TYPE, ASK_CARD_RESOURCE_URI } from "./ask-card";
import { BLOB_RESULT_FACT } from "./blobs";
import { BUILD_APPROVAL_ON_THE_PAGE } from "./connection-request";
import type { McpDeps } from "./deps";
import { createToolListChangedNotifier } from "./notifier";
import { BLOB_RULE, INSTRUCTIONS_BUDGET, openAgentSession, SERVER_INSTRUCTIONS } from "./session";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";
import { authoredToolDefinition, META_TOOL_NAMES } from "./tools";
import { ADVANCED_WHEN, AUTHORING_TOOLS } from "./tools/authoring";
import { executeToolDefinition } from "./tools/execute";
import { ACQUIRE_BLOB_FACT, META_TOOLS } from "./tools/meta";

/**
 * The handshake carries the playbook (GRA-54), and the descriptions carry none of it (GRA-111). A
 * client that loads no skill — Claude.ai, ChatGPT, a bare MCP client — learns how to use Graft from
 * two things and nothing else: the `instructions` field of the `initialize` result and the tool
 * descriptions. This suite holds each to its role: the instructions arrive, fit Claude Code's 2KB
 * cap with the order of operations in the first 512 characters, read in Graft's voice and carry
 * every rule of conduct; every fixed tool's description opens with when it is used, states the
 * handoff shape it can answer, speaks in the third person and carries no rule (ChatGPT's classifier
 * badged the rule-bearing ones "Suspicious Instruction"); and the sentences the instructions share
 * with the Hermes skill (`skills/hermes-graft/SKILL.md`) are present in both, so the two cannot
 * disagree on the order of operations, the approval rule, the secrets rule, the keyless and rotation
 * rules, `run_tool` or where its input schema is read, or the blob rule (GRA-190). One clause is
 * the instructions' alone: what `cardShown: true` means (GRA-120), which a Hermes agent never
 * receives.
 */

const TOKEN = "grft_session_test_token_0000000000000000000000";

/** The skill a Hermes person installs — the root `skills/` directory, MIT (ADR 0015), read here as text. */
const HERMES_SKILL_PATH = fileURLToPath(
  new URL("../../../skills/hermes-graft/SKILL.md", import.meta.url),
);

const sandboxes: FakeSandboxBackend[] = [];
afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
});

/** What the fake deps serve as the ask card's page; the real page is `@graft/ask-card`'s build, read by `ask-card.test.ts` here and held to its rules by `packages/ask-card/src/bundle.test.ts`. */
const FAKE_CARD_HTML = '<!doctype html><html><body><div id="ask"></div></body></html>';

/** A session over the in-memory pair, as `server.test.ts` opens one; `initialize` reads nothing from the deps. */
async function initialize() {
  const store = createFakeStore();
  store.addAgent({ scopeMode: "listed", id: "agent_a", personId: "person_1", token: TOKEN });
  const sandbox = createFakeSandboxBackend();
  sandboxes.push(sandbox);
  const deps: McpDeps = {
    ...createFakeDeps(store),
    sandbox,
    keys: null,
    proxyPublicUrl: "http://localhost:3000/api/proxy",
    checkModule: async () => ({
      entry: null,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    }),
    runnerFiles: async () => [],
    skills: async () => [],
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    askCardHtml: async () => FAKE_CARD_HTML,
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-session-test-handoff-secret-long-enough-32",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
  const notifier = createToolListChangedNotifier();
  const session = await openAgentSession(deps, TOKEN, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "bare-mcp-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

/**
 * Prose as words: markup, brackets and punctuation gone, whitespace collapsed, lower case. The skill
 * writes `\`run_tool { vendor, name, input }\`` and `<vendor>__<name>` where the instructions write
 * `run_tool { vendor, name, input }` and `vendor__name`, and joins clauses with em dashes where the
 * instructions use commas; the words are what must agree.
 */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*<>{}()[\]"']/g, "")
    .replace(/[—–,.;:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the initialize result", () => {
  it("carries the instructions, and they are what SERVER_INSTRUCTIONS says", async () => {
    const harness = await initialize();
    try {
      expect(harness.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await harness.close();
    }
  });
});

/**
 * The ask card (GRA-84; ADR 0006 as amended 2026-09-18) as a host sees it over the handshake: the
 * `resources` capability, one resource listed and readable as the page, the render pointer on
 * exactly the three tools that can ask, the card's own tool hidden by visibility — and the
 * instructions naming `answer_ask` once, as the card's (GRA-111 moved that rule out of the
 * description).
 */
describe("the ask card over the session", () => {
  it("declares resources, lists ui://graft/ask with the app MIME type, and reads it as the page", async () => {
    const harness = await initialize();
    try {
      expect(harness.client.getServerCapabilities()?.resources).toEqual({});
      const { resources } = await harness.client.listResources();
      expect(resources).toEqual([
        expect.objectContaining({ uri: ASK_CARD_RESOURCE_URI, mimeType: ASK_CARD_MIME_TYPE }),
      ]);
      // An empty CSP, said outright, and no domain: the card fetches nothing (the file's header
      // says why); each extension key beside ChatGPT's alias of it (GRA-112).
      expect(resources[0]?._meta).toEqual({
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        "openai/widgetPrefersBorder": true,
        "openai/widgetDescription": expect.stringContaining("Graft's ask card"),
      });
      const read = await harness.client.readResource({ uri: ASK_CARD_RESOURCE_URI });
      expect(read.contents).toEqual([
        { uri: ASK_CARD_RESOURCE_URI, mimeType: ASK_CARD_MIME_TYPE, text: FAKE_CARD_HTML },
      ]);
      await expect(harness.client.readResource({ uri: "ui://graft/other" })).rejects.toThrow(
        /Unknown resource/,
      );
    } finally {
      await harness.close();
    }
  });

  it("points every tool that can ask at the card, under both keys, and nothing else", async () => {
    const harness = await initialize();
    try {
      const { tools } = await harness.client.listTools();
      const rendering = tools
        .filter((tool) => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri)
        .map((tool) => tool.name)
        .sort();
      // The three asking meta-tools, run_tool, and every tool outside the fixed set — the
      // execute__ tools and the authored tools in the list — whose first write is the tool ask
      // (GRA-116): a host renders a card only for a tool whose definition names the resource.
      const asking = tools
        .map((tool) => tool.name)
        .filter(
          (name) =>
            ["acquire", "request_connection", "request_credential", "run_tool"].includes(name) ||
            !META_TOOL_NAMES.includes(name),
        )
        .sort();
      expect(rendering).toEqual(asking);
      // ChatGPT's alias rides on exactly the same set (GRA-112).
      const aliased = tools
        .filter((tool) => tool._meta?.["openai/outputTemplate"] !== undefined)
        .map((tool) => tool.name)
        .sort();
      expect(aliased).toEqual(rendering);
      for (const name of rendering) {
        expect(tools.find((tool) => tool.name === name)?._meta).toEqual({
          ui: { resourceUri: ASK_CARD_RESOURCE_URI },
          "openai/outputTemplate": ASK_CARD_RESOURCE_URI,
        });
      }
    } finally {
      await harness.close();
    }
  });

  it("lists answer_ask, start_link and ask_status as app-only — the host hides them; this server cannot — each with a description that says whose it is", async () => {
    const harness = await initialize();
    try {
      const { tools } = await harness.client.listTools();
      // The card's three tools (GRA-84; GRA-117 added the link's start and the status read).
      for (const name of ["answer_ask", "start_link", "ask_status"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?._meta, name).toEqual({ ui: { visibility: ["app"] } });
        expect(tool?.description?.startsWith("Called by Graft's ask card"), name).toBe(true);
      }
      // No other tool is app-only.
      expect(
        tools
          .filter((tool) => (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["answer_ask", "ask_status", "start_link"]);
      // The status read is the one of the three a host may call freely: it records nothing.
      expect(tools.find((tool) => tool.name === "ask_status")?.annotations?.readOnlyHint).toBe(
        true,
      );
    } finally {
      await harness.close();
    }
  });

  it("has the instructions name answer_ask once, as the card's and not the model's", () => {
    expect(SERVER_INSTRUCTIONS).toContain("answer_ask is the ask card's, not yours.");
    expect(SERVER_INSTRUCTIONS.match(/answer_ask/g)).toHaveLength(1);
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  /** 2,048: Claude Code's per-server cap on the field (CHANGELOG 2.1.84), the one a host documents. */
  it("stays under the budget, which is the one documented cap", () => {
    expect(INSTRUCTIONS_BUDGET).toBe(2_048);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(INSTRUCTIONS_BUDGET / 2);
  });

  /** OpenAI: "Keep the most important details in the first 512 characters" (plugins/build/mcp-server). */
  it("puts the order of operations in the first 512 characters", () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    for (const step of [
      "Call find_tool first",
      "promote it",
      "call request_connection",
      "Call acquire only when nothing fits",
    ]) {
      expect(head, step).toContain(step);
    }
  });

  /** The rules GRA-111 moved out of the descriptions, each present here in the words the skill uses. */
  it("carries every rule of conduct the descriptions used to", () => {
    for (const rule of [
      "There is no route to a vendor except through a Graft tool.",
      "Never propose a made-up key for a vendor that documents none.",
      "A rotated or expired credential is request_credential on the existing connection, never a new one.",
      "so do not tell the person to expect one",
      "answer_ask is the ask card's, not yours.",
    ]) {
      expect(SERVER_INSTRUCTIONS, rule).toContain(rule);
    }
  });

  /**
   * The card clause (GRA-120; ADR 0006 as amended 2026-09-20): an awaiting answer with `cardShown:
   * true` is answered on the card in the conversation, and the url is relayed only to a person who
   * says they cannot see it. It sits beside the handoff rule, so a client reading the first 512
   * characters plus the handoff paragraph has both. It is the instructions' alone and deliberately
   * **not** in the Hermes skill: Hermes renders no card and holds a static token, so its awaiting
   * answers never carry `cardShown` (`card-client.ts`), and a rule about a field it never sees
   * would be noise in the skill. The SHARED list below therefore does not name it.
   */
  it("says what cardShown: true means, right after the handoff rule, and the skill does not", async () => {
    const clause =
      "If cardShown is true the ask is on a card in this conversation: relay the url only if they say they cannot see it.";
    expect(SERVER_INSTRUCTIONS).toContain(clause);
    expect(SERVER_INSTRUCTIONS.indexOf(clause)).toBeGreaterThan(
      SERVER_INSTRUCTIONS.indexOf("call the same tool again with the same arguments"),
    );
    expect(SERVER_INSTRUCTIONS.indexOf(clause)).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("Never ask the person for an API key"),
    );
    const skill = await readFile(HERMES_SKILL_PATH, "utf8");
    expect(skill).not.toContain("cardShown");
  });

  it("reads in Graft's voice: no em dashes, no exclamation marks, no avoided nouns", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/[—!]/);
    // CONTEXT.md's Avoid lists, the ones a playbook is most tempted by.
    for (const avoided of [/\buser\b/i, /\bintegration\b/i, /\bharness\b/i, /\bbuiltin\b/i]) {
      expect(SERVER_INSTRUCTIONS).not.toMatch(avoided);
    }
  });

  /** The order the ticket fixes: search, then promote, then a connection, then author. */
  it("gives the order of operations in order: find_tool, promote, request_connection, acquire, acquire_status", () => {
    const steps = [
      "Call find_tool first",
      "promote it",
      "call request_connection",
      "Call acquire only when nothing fits",
      "poll acquire_status",
      "Do not start a second acquire for the same goal",
    ];
    const positions = steps.map((step) => SERVER_INSTRUCTIONS.indexOf(step));
    for (const [i, position] of positions.entries()) {
      expect(position, steps[i]).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(position, steps[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
  });

  it("names the four handoffs, run_tool for a snapshotted list, and the wire name", () => {
    for (const fact of [
      "awaiting_",
      "(approval, connection, credential, scope)",
      "exactly as returned",
      "then wait",
      "cardShown",
      "run_tool { vendor, name, input }",
      "inputSchema for run_tool",
      "notifications/tools/list_changed",
      "vendor__name",
      // GRA-190 spent the four tools' names on the blob rule: `ADVANCED_WHEN` opens each of their
      // descriptions with what they are, so the rule needs only the set's name.
      "the authoring tools or execute__ tools",
    ]) {
      expect(SERVER_INSTRUCTIONS, fact).toContain(fact);
    }
  });

  /**
   * The blob rule (GRA-190; ADR 0023): one clause, in `run_tool`'s paragraph since both are about
   * what a result and the next input carry, and the same words in the Hermes skill (SHARED below).
   * The budget was measured before it was written: 2,045 of 2,048 before, so the clause was paid
   * for by tightening facts the descriptions carry, and the order of operations stayed inside the
   * first 512 characters, which the test above holds.
   */
  it("carries the blob rule after the snapshotted-list rule, and the facts stay in the descriptions", () => {
    expect(SERVER_INSTRUCTIONS).toContain(BLOB_RULE);
    expect(SERVER_INSTRUCTIONS.indexOf(BLOB_RULE)).toBeGreaterThan(
      SERVER_INSTRUCTIONS.indexOf("notifications/tools/list_changed"),
    );
    expect(BLOB_RULE).toContain("blob:// ref");
    expect(BLOB_RULE).toContain("never as content");
    expect(BLOB_RULE).toContain("run the producing tool before acquiring the consuming one");
    // The list's field names and the door's reason words are the descriptions' alone.
    for (const fact of ["expiresAt", "blob_not_found", "blob_expired", "blob_quota", "fixture"]) {
      expect(SERVER_INSTRUCTIONS, fact).not.toContain(fact);
    }
  });
});

/**
 * The sentence each meta-tool's description opens with — when it is used, stated as a fact (GRA-111:
 * "Used when", "Used for", never "Call X when") — pinned so a rewrite that loses the "when" or turns
 * it back into an instruction fails here. Keyed by wire name, and the key set is the meta-tool set:
 * a new meta-tool with no entry fails too. The order-of-operations facts are GRA-54's: find_tool
 * before acquire, promote for a found tool, request_connection for a vendor with no connection,
 * acquire when nothing covers the task, run_tool for a tool not in the visible list.
 */
const WHEN: Record<string, string> = {
  acquire:
    "Used when find_tool found nothing that covers the task and the vendor has a connection in the agent's scope",
  acquire_status: "Used with the jobId acquire answered",
  find_tool: "Used first, before acquire, for a task no listed tool covers",
  promote: "Used for a tool find_tool found that is not in the agent's working set",
  demote: "Used for a tool the agent no longer needs in its working set",
  run_tool:
    "Runs a toolbox tool by vendor and name, for the case where it is not in the agent's visible list",
  request_connection: "Used when the vendor a task needs has no connection in the agent's scope",
  request_credential: "Used when a tool's call comes back with the vendor's 401 or 403",
  // The ask card's tools (GRA-84; GRA-117 added the link's start and the status read): the host
  // hides them from the model; each description says whose it is.
  answer_ask: "Called by Graft's ask card",
  start_link: "Called by Graft's ask card",
  ask_status: "Called by Graft's ask card",
};

/** The tools that can answer a handoff, and so must state its shape. */
const HANDS_OFF = ["acquire", "run_tool", "request_connection", "request_credential"];

describe("every meta-tool description", () => {
  it("has a when sentence in the table, and the table names every meta-tool", () => {
    expect(META_TOOLS.map((tool) => tool.definition.name).sort()).toEqual(Object.keys(WHEN).sort());
  });

  for (const tool of META_TOOLS) {
    const name = tool.definition.name;
    it(`${name} opens with when it is used`, () => {
      expect(tool.definition.description?.startsWith(WHEN[name] ?? "\u0000")).toBe(true);
    });
  }

  /** An empty search is not always acquire next: a vendor with no connection in scope needs request_connection first (Greptile on #32). */
  it("find_tool sends an empty answer to request_connection before acquire when the vendor has no connection", () => {
    const description = META_TOOLS.find((tool) => tool.definition.name === "find_tool")?.definition
      .description;
    expect(description).toContain(
      "request_connection when the vendor has no connection in the agent's scope",
    );
  });

  /**
   * The handoff as a fact about the answer (GRA-111): the awaiting word, the url, and that the same
   * call continues it. What the agent does with the link is the instructions' handoff rule.
   */
  for (const name of HANDS_OFF) {
    it(`${name} states the handoff shape it can answer`, () => {
      const description = META_TOOLS.find((tool) => tool.definition.name === name)?.definition
        .description;
      expect(description).toContain("awaiting_");
      expect(description).toMatch(/awaiting_\w+ with a url/);
      expect(description).toMatch(/the same (call|proposal)/);
    });
  }
});

/**
 * Descriptions describe; instructions instruct (GRA-111). ChatGPT's prompt-injection classifier read
 * the rule-bearing descriptions GRA-54 wrote as a "Suspicious Instruction" and badged the person's
 * confirmation on every call, and both hosts' published guidance says the same thing: Anthropic's
 * review criteria, "Describe what the tool does. Do not tell Claude how to behave."; OpenAI's, put
 * "required tool sequences" in `instructions`. So a fixed tool's definition is a capability
 * statement in the third person: no imperative to the model, no rule of conduct, not a word about
 * how the person is to be spoken to. The denylist is the markers those carry, and the whole
 * definition is scanned, since a property description is metadata the host reads too.
 * `SERVER_INSTRUCTIONS` is exempt by design; it is where those words belong.
 */
const CONDUCT_MARKERS = [
  /\bnever\b/i,
  /\bdo not\b/i,
  /\balways\b/i,
  /\byou must\b/i,
  /tell the person/i,
  /ask the person/i,
  // Third person: the description speaks of "the agent" and "the person", not to "you".
  /\byou\b/i,
  /\byour\b/i,
];

/** One connection in scope, as `executeToolDefinition` reads it. */
const DEMO_CONNECTION: ConnectionOutput = {
  id: "conn_1",
  provider: "keyring",
  vendor: "demo",
  displayName: "Demo Orders",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-demo-key" },
  primaryHost: "https://api.demo.example",
  hosts: ["api.demo.example"],
  credentialSetAt: null,
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("every fixed tool's definition", () => {
  const definitions = () => [
    ...META_TOOLS.map((tool) => tool.definition),
    ...AUTHORING_TOOLS.map((tool) => tool.definition),
    executeToolDefinition(DEMO_CONNECTION),
  ];

  for (const definition of definitions()) {
    it(`${definition.name} carries no rule of conduct and speaks in the third person`, () => {
      const text = JSON.stringify(definition);
      for (const marker of CONDUCT_MARKERS) {
        expect(text, String(marker)).not.toMatch(marker);
      }
    });

    /** Claude Code truncates a description at 2KB, the same cap as the instructions (CHANGELOG 2.1.84). */
    it(`${definition.name}'s description fits the 2KB a host truncates at`, () => {
      expect(definition.description?.length ?? 0).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    });
  }
});

describe("the authoring set and the execute tool", () => {
  for (const tool of AUTHORING_TOOLS) {
    it(`${tool.definition.name} opens with the advanced-set when sentence`, () => {
      expect(tool.definition.description?.startsWith(ADVANCED_WHEN)).toBe(true);
    });
  }

  it("execute__<connection id> says it is the by-hand path and states the build ask's shape", () => {
    const definition = executeToolDefinition(DEMO_CONNECTION);
    expect(definition.description).toContain(
      "for an agent the person asked to author a tool itself rather than through acquire",
    );
    expect(definition.description).toContain("awaiting_approval with a url");
    expect(definition.description).toMatch(/the same call/);
  });
});

/**
 * Both hints, said outright, on every fixed tool (GRA-114). MCP reads an unset `destructiveHint` as
 * true, and ChatGPT's Actions list tagged acquire, publish_tool, write_file, run_command, run_tool
 * and execute__ DESTRUCTIVE for it. The rule: `false` wherever the tool destroys nothing at a vendor
 * — acquire dry-runs (ADR 0004), publish_tool writes the person's toolbox, write_file and run_command
 * act in the agent's sandbox — and `true` on the two that carry another request, whose hint only
 * the carried tool's own annotations (the check's, GRA-3) can say. Keyed by wire name; the key set is
 * the fixed tool set, so a new tool with no row here fails.
 */
const HINTS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  acquire: { readOnlyHint: false, destructiveHint: false },
  acquire_status: { readOnlyHint: true, destructiveHint: false },
  find_tool: { readOnlyHint: true, destructiveHint: false },
  promote: { readOnlyHint: false, destructiveHint: false },
  demote: { readOnlyHint: false, destructiveHint: false },
  run_tool: { readOnlyHint: false, destructiveHint: true },
  request_connection: { readOnlyHint: false, destructiveHint: false },
  request_credential: { readOnlyHint: false, destructiveHint: false },
  answer_ask: { readOnlyHint: false, destructiveHint: false },
  start_link: { readOnlyHint: false, destructiveHint: false },
  ask_status: { readOnlyHint: true, destructiveHint: false },
  write_file: { readOnlyHint: false, destructiveHint: true },
  read_file: { readOnlyHint: true, destructiveHint: false },
  run_command: { readOnlyHint: false, destructiveHint: true },
  wait_for_process: { readOnlyHint: true, destructiveHint: false },
  read_web_page: { readOnlyHint: true, destructiveHint: false },
  check_tool: { readOnlyHint: true, destructiveHint: false },
  publish_tool: { readOnlyHint: false, destructiveHint: false },
  read_tool_source: { readOnlyHint: true, destructiveHint: false },
};

/** The one sentence run_tool and execute__ carry for their `destructiveHint: true` (GRA-114). */
const CARRIED_HINT =
  /Marked destructive because the hint is the carried (tool|command)'s, which the host cannot know per call/;

describe("every fixed tool's annotations", () => {
  const fixed = [...META_TOOLS, ...AUTHORING_TOOLS];

  it("has a row in the table, and the table names every fixed tool", () => {
    expect(fixed.map((tool) => tool.definition.name).sort()).toEqual(Object.keys(HINTS).sort());
  });

  for (const tool of fixed) {
    const name = tool.definition.name;
    it(`${name} declares both hints, and they are the table's`, () => {
      // `toEqual` on the whole object: a hint left unset is a failure, not a default.
      expect(tool.definition.annotations).toEqual(HINTS[name]);
    });
  }

  it("execute__<connection id> declares both hints, destructive because the command is the request's", () => {
    const definition = executeToolDefinition(DEMO_CONNECTION);
    expect(definition.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(definition.description).toMatch(CARRIED_HINT);
  });

  it("run_tool says its destructive hint is the carried tool's", () => {
    const description = META_TOOLS.find((tool) => tool.definition.name === "run_tool")?.definition
      .description;
    expect(description).toMatch(CARRIED_HINT);
  });

  it("only run_tool, execute__, write_file and run_command are destructive", () => {
    const destructive = Object.entries(HINTS)
      .filter(([, hints]) => hints.destructiveHint)
      .map(([name]) => name);
    expect(destructive).toEqual(["run_tool", "write_file", "run_command"]);
  });

  /** An authored tool's hints are the check's, passed through from the row (ADR 0008), never a default. */
  it("an authored tool in the list carries the row's own hints, both ways", () => {
    const store = createFakeStore();
    const row = (destructive: boolean, readOnly: boolean) =>
      store.addTool({
        id: `tool_${destructive}_${readOnly}`,
        personId: "person_1",
        vendor: "demo",
        name: `hints-${destructive}-${readOnly}`,
        description: "A tool whose hints are the check's.",
        inputSchema: { type: "object", properties: {} },
        readOnly,
        destructive,
        defaultConnectionId: null,
        path: "/tools/demo",
      }).tool;
    expect(authoredToolDefinition(row(true, false)).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(authoredToolDefinition(row(false, true)).annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});

/**
 * The sentences the instructions and the Hermes skill must both carry, as words. One list, two
 * texts: a rule reworded in the skill alone, or in the instructions alone, fails here until the
 * other says the same. The order of operations, the approval rule, the secrets rule, `run_tool`.
 */
const SHARED = [
  // The order of operations.
  "call find_tool first",
  "no authoring needed",
  "only when nothing fits",
  // GRA-125: acquire_status answers only news, so "only when it changed" left the instructions.
  "relay the newest progress line in a sentence",
  "do not start a second acquire for the same goal",
  "unless the person asked you to author by hand",
  // Handoffs.
  "the next step is the person's, in the console",
  "the link exactly as returned",
  "then wait",
  "call the same tool again with the same arguments",
  // Secrets, and the two connection rules GRA-111 moved here from the descriptions.
  // "by any name" since GRA-190, for the budget; it was "whatever the vendor calls it".
  "never ask the person for an API key, a password or a token in chat, by any name",
  "the console is where secrets go; you never see one",
  "never propose a made-up key",
  "request_credential on the existing connection, never a new one",
  "starts without a second link",
  "do not tell the person to expect one",
  // No route to a vendor but a Graft tool.
  "there is no route to a vendor except through a Graft tool",
  // A snapshotted list.
  "some clients snapshot the tool list per conversation",
  "run_tool { vendor, name, input } calls it by name",
  "the acquire result and find_tool carry the tool's inputSchema for run_tool",
  "tools/list_changed",
  // The approval rule (ADR 0008 as amended).
  "a read-only tool never asks",
  "any other tool asks once, and the answer holds",
  "a destructive tool too",
  "set a tool to ask every time",
  "once per agent per connection",
  // The wire name.
  "vendor__name",
  // The blob rule (GRA-190; ADR 0023), the whole clause.
  BLOB_RULE,
];

describe("the instructions and the Hermes skill", () => {
  it("say the same key sentences", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const instructions = words(SERVER_INSTRUCTIONS);
    for (const sentence of SHARED) {
      const needle = words(sentence);
      expect(instructions, `instructions: ${sentence}`).toContain(needle);
      expect(skill, `SKILL.md: ${sentence}`).toContain(needle);
    }
  });
});

/**
 * GRA-75: the person may grant the build approval on the connection page, so no text the agent
 * reads promises a second link. The fact — acquire starts without a second link — is said by four
 * texts: the instructions, `request_connection`'s description, the awaiting answer's sentence and
 * the skill. The rule — do not tell the person to expect one — is the instructions' and the skill's
 * alone (GRA-111), and the description is checked not to carry it, nor the word "approval" (GRA-121).
 * Compared as words, like SHARED.
 */
describe("the build approval on the connection page", () => {
  it("is a fact in four texts and a rule in two", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const description = words(
      META_TOOLS.find((tool) => tool.definition.name === "request_connection")?.definition
        .description ?? "",
    );
    const awaiting = words(BUILD_APPROVAL_ON_THE_PAGE);
    const instructions = words(SERVER_INSTRUCTIONS);
    const fact = words("starts without a second link");
    for (const [name, text] of [
      ["instructions", instructions],
      ["description", description],
      ["awaiting answer", awaiting],
      ["SKILL.md", skill],
    ] as const) {
      expect(text, name).toContain(fact);
    }
    // The instructions name the approval; the description says only that building is offered, on
    // by default (GRA-121: "approval" in a description was one of the words the classifier named).
    expect(instructions).toContain(words("build approval, on by default"));
    expect(description).toContain(words("on by default"));
    expect(description).not.toContain("approval");
    const rule = words("do not tell the person to expect one");
    expect(instructions).toContain(rule);
    expect(skill).toContain(rule);
    expect(description).not.toContain(rule);
  });
});

/**
 * The blob facts (GRA-190; ADR 0023) are the descriptions': the `blobs` list a result may carry
 * and the door's three refusals on `run_tool` and on every authored tool in the list, since any
 * tool may write a blob and any input may name one; and on `acquire`, where the ref the dry run
 * reads comes from and the fixture the job mints without one. Third person, no conduct word, the
 * denylist above applied to the authored definition too, since it is not among the fixed ones.
 */
describe("the blob facts in the descriptions", () => {
  const description = (name: string) =>
    META_TOOLS.find((tool) => tool.definition.name === name)?.definition.description ?? "";

  it("run_tool names the blobs list's five fields and the door's three refusals", () => {
    expect(description("run_tool")).toContain(BLOB_RESULT_FACT);
    for (const fact of [
      "ref (a blob:// string), bytes, contentType, name and expiresAt",
      "blob_not_found",
      "24 hours have passed blob_expired",
      "blob_quota",
    ]) {
      expect(BLOB_RESULT_FACT, fact).toContain(fact);
    }
  });

  it("every authored tool in the list carries the same fact after the row's own words, and no conduct word", () => {
    const store = createFakeStore();
    const { tool } = store.addTool({
      id: "tool_blob_fact",
      personId: "person_1",
      vendor: "demo",
      name: "save-report",
      description: "Saves the Demo Orders report as a file.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      destructive: false,
      defaultConnectionId: null,
      path: "/tools/demo",
    });
    const definition = authoredToolDefinition(tool);
    expect(definition.description).toBe(`${tool.description} ${BLOB_RESULT_FACT}`);
    expect(definition.description?.length ?? 0).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    const text = JSON.stringify(definition);
    for (const marker of CONDUCT_MARKERS) {
      expect(text, String(marker)).not.toMatch(marker);
    }
  });

  it("acquire says a test input may name a blob:// ref and that the job mints a fixture without one", () => {
    expect(description("acquire")).toContain(ACQUIRE_BLOB_FACT);
    expect(ACQUIRE_BLOB_FACT).toContain("blob:// ref");
    expect(ACQUIRE_BLOB_FACT).toContain("test input");
    expect(ACQUIRE_BLOB_FACT).toContain("mints a fixture blob");
    const hints = META_TOOLS.find((tool) => tool.definition.name === "acquire")?.definition
      .inputSchema.properties?.hints as { description?: string } | undefined;
    expect(hints?.description).toContain("blob:// ref");
  });
});

/**
 * The rotation rule (ADR 0008 as amended 2026-09-18; GRA-76) is the instructions' and the skill's
 * (GRA-111 moved it out of the two connection descriptions, where ChatGPT's classifier read it as
 * an instruction). One sentence, two texts, compared as words; and neither connection description
 * says "never" about anything.
 */
const ROTATION_RULE =
  "a rotated or expired credential is request_credential on the existing connection, never a new one";

describe("the rotation rule", () => {
  it("is said by the instructions and the Hermes skill, and by no description", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const needle = words(ROTATION_RULE);
    expect(words(SERVER_INSTRUCTIONS), "instructions").toContain(needle);
    expect(skill, "SKILL.md").toContain(needle);
    for (const name of ["request_connection", "request_credential"]) {
      const description = META_TOOLS.find((tool) => tool.definition.name === name)?.definition
        .description;
      expect(words(description ?? ""), name).not.toContain("never");
    }
  });

  /**
   * The scope ask (GRA-104): a connection the person holds that this agent was not given is a
   * handoff, `awaiting_scope`, named in the instructions' handoff list, in `request_connection`'s
   * description and in the skill — so no text the agent reads sends the person to find the Scope
   * page on their own.
   */
  it("name awaiting_scope as the fourth handoff, with no new connection and nothing entered", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const description = words(
      META_TOOLS.find((tool) => tool.definition.name === "request_connection")?.definition
        .description ?? "",
    );
    expect(description).toContain("awaiting_scope");
    expect(description).toContain(words("no new connection, nothing entered"));
    expect(skill).toContain("awaiting_scope");
    expect(skill).toContain(words("no new connection, nothing entered"));
    expect(words(SERVER_INSTRUCTIONS)).toContain(
      words("(approval, connection, credential, scope)"),
    );
  });
});
