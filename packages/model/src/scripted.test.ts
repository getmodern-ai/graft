import { describe, expect, it } from "vitest";

import { CONFORMANCE_CONTEXT, modelConformance } from "./conformance";
import {
  createScriptedModel,
  DEFAULT_SCRIPTED_USAGE,
  parseScript,
  ScriptExhaustedError,
  type ScriptedStep,
  ScriptMismatchError,
} from "./scripted";
import type { ModuleDraft } from "./types";

/**
 * The scripted backing against the conformance suite, and the two ways a script can be wrong. A
 * script here is the loop's shortest honest path — docs, a draft, a fix after the check, a fix
 * after the dry run — which is also the path every `acquire` test in `@graft/mcp` writes its own
 * variant of.
 */

const DRAFT: ModuleDraft = {
  name: "list-items",
  description: "Lists items from Demo Orders, up to a limit.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  },
  files: [
    {
      path: "index.ts",
      content: [
        "export default async (input: Input, ctx: Context) => {",
        "  const res = await ctx.fetch(`/items?limit=` + (input.limit ?? 5));",
        "  if (!res.ok) throw new Error(`GET /items ` + res.status);",
        "  return await res.json();",
        "};",
        "",
      ].join("\n"),
    },
  ],
  testInput: { limit: 2 },
  proofReads: [{ path: "/items?limit=1" }],
};

const SCRIPT: ScriptedStep[] = [
  {
    on: "goal",
    answer: {
      kind: "read_docs",
      urls: ["https://docs.demo.example/items"],
      note: "Reading the Items page of the Demo Orders documentation.",
    },
  },
  { on: "docs", answer: { kind: "write_module", draft: DRAFT, note: "Drafted list-items." } },
  {
    on: "check_refused",
    answer: { kind: "write_module", draft: DRAFT, note: "Made the path vendor-relative." },
  },
  {
    on: "dry_run_failed",
    answer: { kind: "write_module", draft: DRAFT, note: "Fixed the path to /items." },
  },
];

modelConformance("scripted", async () => ({ adapter: createScriptedModel(SCRIPT) }));

describe("the scripted model", () => {
  it("plays its steps in order, reports the step's usage or the default, and records what it was shown", async () => {
    const model = createScriptedModel([
      {
        on: "goal",
        answer: { kind: "give_up", reason: "nothing to do" },
        usage: { inputTokens: 7, outputTokens: 3 },
      },
      { on: "goal", answer: { kind: "give_up", reason: "still nothing" } },
    ]);
    const conversation = model.open(CONFORMANCE_CONTEXT);
    expect(await conversation.turn({ kind: "goal" })).toEqual({
      answer: { kind: "give_up", reason: "nothing to do" },
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect((await conversation.turn({ kind: "goal" })).usage).toEqual(DEFAULT_SCRIPTED_USAGE);
    expect(model.conversations).toHaveLength(1);
    expect(model.conversations[0]?.situations.map((s) => s.kind)).toEqual(["goal", "goal"]);
  });

  it("refuses a situation its next step was not written for, and an exhausted script, by name", async () => {
    const model = createScriptedModel(SCRIPT.slice(0, 1));
    const conversation = model.open(CONFORMANCE_CONTEXT);
    await expect(conversation.turn({ kind: "docs", pages: [] })).rejects.toBeInstanceOf(
      ScriptMismatchError,
    );
    await conversation.turn({ kind: "goal" });
    await expect(conversation.turn({ kind: "docs", pages: [] })).rejects.toBeInstanceOf(
      ScriptExhaustedError,
    );
  });

  it("starts every conversation from the first step", async () => {
    const model = createScriptedModel(SCRIPT);
    const a = model.open(CONFORMANCE_CONTEXT);
    await a.turn({ kind: "goal" });
    await a.turn({ kind: "docs", pages: [] });
    const b = model.open(CONFORMANCE_CONTEXT);
    expect((await b.turn({ kind: "goal" })).answer.kind).toBe("read_docs");
  });
});

describe("parseScript", () => {
  it("reads the JSON form, bare array or under steps, into the same steps", () => {
    const json = JSON.parse(JSON.stringify({ steps: SCRIPT }));
    expect(parseScript(json)).toEqual(SCRIPT);
    expect(parseScript(JSON.parse(JSON.stringify(SCRIPT)))).toEqual(SCRIPT);
  });

  /** GRA-213: a proof read is a path on the primary host, or `{ path, host }` on another declared one. */
  it("reads a proof read as a path or as { path, host }, and refuses anything else naming the step", () => {
    const draft = { name: "x", description: "d", inputSchema: { type: "object" } };
    const files = [{ path: "index.ts", content: "" }];
    const [written, proven] = parseScript([
      {
        on: "goal",
        answer: {
          kind: "write_module",
          note: "n",
          draft: {
            ...draft,
            files,
            proofReads: [
              "/v1/forecast",
              { path: "/v1/search", host: "geocoding-api.open-meteo.com" },
              { path: "/v1/other", host: null },
            ],
          },
        },
      },
      {
        on: "proof",
        answer: {
          kind: "prove",
          note: "n",
          proofReads: [{ path: "/v1/search?name=Berlin", host: "geocoding-api.open-meteo.com" }],
        },
      },
    ]);
    expect(written?.answer).toMatchObject({
      draft: {
        proofReads: [
          { path: "/v1/forecast" },
          { path: "/v1/search", host: "geocoding-api.open-meteo.com" },
          { path: "/v1/other" },
        ],
      },
    });
    expect(proven?.answer).toEqual({
      kind: "prove",
      note: "n",
      proofReads: [{ path: "/v1/search?name=Berlin", host: "geocoding-api.open-meteo.com" }],
    });
    expect(() =>
      parseScript([
        {
          on: "goal",
          answer: { kind: "write_module", note: "n", draft: { ...draft, files, proofReads: [7] } },
        },
      ]),
    ).toThrow(/step 1: the draft's "proofReads" must be an array of paths, or of \{ path, host \}/);
    expect(() =>
      parseScript([
        { on: "proof", answer: { kind: "prove", note: "n", proofReads: [{ host: "a.example" }] } },
      ]),
    ).toThrow(/step 1: a prove answer carries "proofReads"/);
  });

  it("fills a draft's optional fields and refuses a malformed step naming it", () => {
    const [parsed] = parseScript([
      {
        on: "goal",
        answer: {
          kind: "write_module",
          note: "n",
          draft: {
            name: "x",
            description: "d",
            inputSchema: { type: "object" },
            files: [{ path: "index.ts", content: "" }],
          },
        },
      },
    ]);
    expect(parsed?.answer).toMatchObject({
      kind: "write_module",
      draft: { testInput: {}, proofReads: [] },
    });
    expect(() => parseScript([{ on: "later", answer: { kind: "give_up", reason: "r" } }])).toThrow(
      /step 1: "on" must be one of/,
    );
    expect(() => parseScript([{ on: "goal", answer: { kind: "proceed" } }])).toThrow(
      /step 1: a proceed answer carries a "note"/,
    );
    expect(() =>
      parseScript([
        {
          on: "goal",
          answer: { kind: "give_up", reason: "r" },
          usage: { inputTokens: 1.5, outputTokens: 0 },
        },
      ]),
    ).toThrow(/step 1: "usage"/);
    expect(() => parseScript({ nope: true })).toThrow(/array of steps/);
  });
});
