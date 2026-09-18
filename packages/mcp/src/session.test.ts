import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { ASK_CARD_MIME_TYPE, ASK_CARD_RESOURCE_URI } from "./ask-card";
import { BUILD_APPROVAL_ON_THE_PAGE } from "./connection-request";
import type { McpDeps } from "./deps";
import { createToolListChangedNotifier } from "./notifier";
import { INSTRUCTIONS_BUDGET, openAgentSession, SERVER_INSTRUCTIONS } from "./session";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";
import { ADVANCED_WHEN, AUTHORING_TOOLS } from "./tools/authoring";
import { executeToolDefinition } from "./tools/execute";
import { META_TOOLS } from "./tools/meta";

/**
 * The handshake carries the playbook (GRA-54). A client that loads no skill — Claude.ai, ChatGPT, a
 * bare MCP client — learns how to use Graft from two things and nothing else: the `instructions`
 * field of the `initialize` result and the tool descriptions. This suite holds both to what the
 * ticket asks: the instructions arrive, fit the budget some clients truncate at, and read in Graft's
 * voice; every fixed tool's description opens with when to call it and says what to do with a
 * handoff where it can return one; and the sentences the instructions share with the Hermes skill
 * (`skills/hermes-graft/SKILL.md`) are present in both, so the two cannot disagree on the order of
 * operations, the approval rule, the secrets rule, `run_tool` or where its input schema is read.
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
 * instructions untouched, since the card is the host's affair and the budget is spent.
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
      // No CSP and no domain on the resource: the card fetches nothing (the file's header says why).
      expect(resources[0]).not.toHaveProperty("_meta");
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

  it("points acquire, request_connection and request_credential at the card, and nothing else", async () => {
    const harness = await initialize();
    try {
      const { tools } = await harness.client.listTools();
      const rendering = tools
        .filter((tool) => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri)
        .map((tool) => tool.name)
        .sort();
      expect(rendering).toEqual(["acquire", "request_connection", "request_credential"]);
      for (const name of rendering) {
        expect(tools.find((tool) => tool.name === name)?._meta).toEqual({
          ui: { resourceUri: ASK_CARD_RESOURCE_URI },
        });
      }
    } finally {
      await harness.close();
    }
  });

  it("lists answer_ask as app-only — the host hides it; this server cannot — with a description that tells a model off", async () => {
    const harness = await initialize();
    try {
      const { tools } = await harness.client.listTools();
      const answerAsk = tools.find((tool) => tool.name === "answer_ask");
      expect(answerAsk?._meta).toEqual({ ui: { visibility: ["app"] } });
      expect(answerAsk?.description?.startsWith("Called by Graft's ask card, never by you:")).toBe(
        true,
      );
      // No other tool is app-only.
      expect(
        tools.filter(
          (tool) => (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility,
        ),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("leaves the instructions untouched: no card, no answer_ask, the budget as it was", () => {
    expect(SERVER_INSTRUCTIONS).not.toContain("answer_ask");
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bcard\b/);
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  it("stays under the budget some clients truncate at", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(INSTRUCTIONS_BUDGET / 2);
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
      "run_tool { vendor, name, input }",
      "inputSchema for run_tool",
      "notifications/tools/list_changed",
      "vendor__name",
      "the authoring tools (read_web_page, write_file, check_tool, publish_tool) or an execute__ tool",
    ]) {
      expect(SERVER_INSTRUCTIONS, fact).toContain(fact);
    }
  });
});

/**
 * The sentence each meta-tool's description opens with — when to call it — pinned so a rewrite that
 * loses the "when" fails here. Keyed by wire name, and the key set is the meta-tool set: a new
 * meta-tool with no entry fails too.
 */
const WHEN: Record<string, string> = {
  acquire: "Call acquire when find_tool found nothing that covers the task",
  acquire_status: "Call acquire_status with the jobId acquire returned",
  find_tool: "Call find_tool first, before acquire, whenever a task has no tool in your list",
  promote: "Call promote when find_tool found a tool that is not in your working set",
  demote: "Call demote when you no longer need a tool in your working set",
  run_tool:
    "Call run_tool to run a toolbox tool by vendor and name when it is not in your visible list",
  request_connection:
    "Call request_connection when the vendor a task needs has no connection in your scope",
  request_credential:
    "Call request_credential when a tool's call comes back with the vendor's 401 or 403",
  // The ask card's tool (GRA-84): the host hides it from the model; the "when" is a "never".
  answer_ask: "Called by Graft's ask card, never by you",
};

/** The tools that can answer a handoff, and so must say what to do with one. */
const HANDS_OFF = ["acquire", "run_tool", "request_connection", "request_credential"];

describe("every meta-tool description", () => {
  it("has a when sentence in the table, and the table names every meta-tool", () => {
    expect(META_TOOLS.map((tool) => tool.definition.name).sort()).toEqual(Object.keys(WHEN).sort());
  });

  for (const tool of META_TOOLS) {
    const name = tool.definition.name;
    it(`${name} says when to call it`, () => {
      expect(tool.definition.description).toContain(WHEN[name]);
    });
  }

  /** An empty search is not always acquire next: a vendor with no connection in scope needs request_connection first (Greptile on #32). */
  it("find_tool sends an empty answer to request_connection before acquire when the vendor has no connection", () => {
    const description = META_TOOLS.find((tool) => tool.definition.name === "find_tool")?.definition
      .description;
    expect(description).toContain(
      "call request_connection if the vendor has no connection in your scope",
    );
  });

  for (const name of HANDS_OFF) {
    it(`${name} says what to do with the handoff it can return`, () => {
      const description = META_TOOLS.find((tool) => tool.definition.name === name)?.definition
        .description;
      expect(description).toContain("awaiting_");
      expect(description).toContain("exactly as returned");
      expect(description).toMatch(/call (acquire |it )?again/);
    });
  }
});

describe("the authoring set and the execute tool", () => {
  for (const tool of AUTHORING_TOOLS) {
    it(`${tool.definition.name} opens with the advanced-set when sentence`, () => {
      expect(tool.definition.description?.startsWith(ADVANCED_WHEN)).toBe(true);
    });
  }

  it("execute__<connection id> says it is the by-hand path and what to do with the build ask", () => {
    const definition = executeToolDefinition({
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
    });
    expect(definition.description).toContain(
      "when the person asked you to author a tool yourself rather than through acquire",
    );
    expect(definition.description).toContain("awaiting_approval");
    expect(definition.description).toContain("exactly as returned");
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
  "in one sentence, only when it changed",
  "do not start a second acquire for the same goal",
  "unless the person asked you to author by hand",
  // Handoffs.
  "the next step is the person's, in the console",
  "the link exactly as returned",
  "then wait",
  "call the same tool again with the same arguments",
  // Secrets.
  "never ask the person for an API key, a password or a token in chat, whatever the vendor calls it",
  "the console is where secrets go; you never see one",
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
 * reads promises a second link. Pinned as words, like SHARED, between `request_connection`'s
 * description, the awaiting answer's sentence and the skill — not the instructions, which have no
 * room for it under the budget (1774 of 1800 on 2026-09-18); the description is the long form.
 */
describe("the build approval on the connection page", () => {
  it("is said the same way by request_connection's description, its awaiting answer and the Hermes skill", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const description = words(
      META_TOOLS.find((tool) => tool.definition.name === "request_connection")?.definition
        .description ?? "",
    );
    const awaiting = words(BUILD_APPROVAL_ON_THE_PAGE);
    for (const sentence of [
      "allow you to build tools against the connection, on by default",
      "acquire against it starts without a second link",
    ]) {
      const needle = words(sentence);
      expect(description, `description: ${sentence}`).toContain(needle);
      expect(awaiting, `awaiting answer: ${sentence}`).toContain(needle);
      expect(skill, `SKILL.md: ${sentence}`).toContain(needle);
    }
    expect(description).toContain(words("do not tell the person to expect one"));
    expect(skill).toContain(words("do not tell the person to expect one"));
  });
});

/**
 * The rotation rule (ADR 0008 as amended 2026-09-18; GRA-76), carried by the two connection tools'
 * descriptions and the skill rather than by the instructions: `SERVER_INSTRUCTIONS` sits within
 * thirty characters of `INSTRUCTIONS_BUDGET`, and the descriptions are the long form a client
 * reads beside them. One sentence, three texts, compared as words.
 */
const ROTATION_RULE =
  "a rotated or expired credential is request_credential against the existing connection, never a new connection: a new connection is a new row with no scope and no approvals";

describe("the connection descriptions and the Hermes skill", () => {
  it("say a rotation is request_credential against the existing connection, never a new one", async () => {
    const skill = words(await readFile(HERMES_SKILL_PATH, "utf8"));
    const needle = words(ROTATION_RULE);
    for (const name of ["request_connection", "request_credential"]) {
      const description = META_TOOLS.find((tool) => tool.definition.name === name)?.definition
        .description;
      expect(words(description ?? ""), name).toContain(needle);
    }
    expect(skill, "SKILL.md").toContain(needle);
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
