import { describe, expect, it } from "vitest";

import {
  draftProblems,
  readWireAnswer,
  TOOL_DESCRIPTION_MAX_LENGTH,
  WIRE_ANSWER_SCHEMA,
  type WireAnswer,
  wireOf,
} from "./answer";
import type { ModelAnswer } from "./types";

/**
 * The reading of a wire answer into a `ModelAnswer`: the situation's admitted kinds, the draft's
 * rules, the two JSON texts — every problem as a sentence the repair turn can put back.
 */

const draft: WireAnswer = {
  kind: "write_module",
  note: "Drafted.",
  urls: [],
  draft: {
    name: "create-order",
    description: "Creates an order for one item and a quantity.",
    inputSchemaJson:
      '{"type":"object","properties":{"itemId":{"type":"string"}},"required":["itemId"]}',
    files: [
      { path: "index.ts", content: "export default async (input: Input, ctx: Context) => ({})" },
    ],
    testInputJson: '{"itemId":"itm_a"}',
    proofReads: ["/items?limit=1"],
  },
};

describe("readWireAnswer", () => {
  it("reads a good draft, parsing the schema and the test input out of their JSON texts", () => {
    const read = readWireAnswer(draft, "goal");
    expect(read).toEqual({
      ok: true,
      answer: {
        kind: "write_module",
        note: "Drafted.",
        draft: {
          name: "create-order",
          description: "Creates an order for one item and a quantity.",
          inputSchema: {
            type: "object",
            properties: { itemId: { type: "string" } },
            required: ["itemId"],
          },
          files: draft.draft?.files,
          testInput: { itemId: "itm_a" },
          proofReads: ["/items?limit=1"],
        },
      },
    });
  });

  it("refuses a kind the situation does not admit, naming the admitted ones", () => {
    const read = readWireAnswer(
      { kind: "proceed", note: "ok", urls: [], draft: null },
      "check_refused",
    );
    expect(read).toEqual({
      ok: false,
      problems: [
        '"proceed" does not answer a "check_refused" situation; answer with one of read_docs, write_module, give_up',
      ],
    });
    expect(readWireAnswer({ kind: "proceed", note: "ok", urls: [], draft: null }, "proof")).toEqual(
      { ok: true, answer: { kind: "proceed", note: "ok" } },
    );
  });

  it("names every problem with a draft at once", () => {
    const read = readWireAnswer(
      {
        ...draft,
        note: " ",
        draft: {
          ...draft.draft,
          name: "Create Order",
          description: "x".repeat(TOOL_DESCRIPTION_MAX_LENGTH + 1),
          inputSchemaJson: '{"type":"array"}',
          files: [{ path: "main.ts", content: "" }],
          testInputJson: "[1]",
          proofReads: ["items"],
        } as NonNullable<WireAnswer["draft"]>,
      },
      "docs",
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems).toEqual([
      "note is empty",
      "testInputJson is not a JSON object",
      'name "Create Order" is not kebab-case',
      `description is longer than ${TOOL_DESCRIPTION_MAX_LENGTH} characters`,
      'inputSchema is not a JSON Schema object with type "object"',
      "files carry no index.ts (or index.mjs) entry",
      'proof read "items" is not a vendor-relative path',
    ]);
    expect(read.problems).not.toContain("testInput is not an object");
  });

  it("refuses read_docs without a usable URL, and give_up without a reason", () => {
    expect(
      readWireAnswer({ kind: "read_docs", note: "n", urls: [" "], draft: null }, "goal"),
    ).toEqual({
      ok: false,
      problems: ["read_docs names no URL to read"],
    });
    expect(
      readWireAnswer(
        { kind: "read_docs", note: "n", urls: ["ftp://x", "docs"], draft: null },
        "goal",
      ),
    ).toEqual({
      ok: false,
      problems: ['"ftp://x" is not an http(s) URL', '"docs" is not an http(s) URL'],
    });
    expect(readWireAnswer({ kind: "give_up", note: "", urls: [], draft: null }, "goal")).toEqual({
      ok: false,
      problems: ["give_up carries no reason in note"],
    });
    expect(
      readWireAnswer({ kind: "give_up", note: "No API.", urls: [], draft: null }, "goal"),
    ).toEqual({ ok: true, answer: { kind: "give_up", reason: "No API." } });
  });

  it("refuses a write_module with no draft and a file path that leaves the module", () => {
    expect(readWireAnswer({ ...draft, draft: null }, "goal")).toEqual({
      ok: false,
      problems: ["write_module carries no draft"],
    });
    const escaped = readWireAnswer(
      {
        ...draft,
        draft: {
          ...draft.draft,
          files: [...(draft.draft?.files ?? []), { path: "../other.ts", content: "" }],
        } as NonNullable<WireAnswer["draft"]>,
      },
      "goal",
    );
    expect(escaped).toEqual({
      ok: false,
      problems: ['file path "../other.ts" is not a plain relative path'],
    });
  });
});

describe("the wire schema and the round trip", () => {
  it("is what structured output can hold: every property present, the free-form values as text", () => {
    const parsed = WIRE_ANSWER_SCHEMA.safeParse(draft);
    expect(parsed.success).toBe(true);
    expect(WIRE_ANSWER_SCHEMA.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(WIRE_ANSWER_SCHEMA.safeParse({ kind: "proceed", note: "ok" }).success).toBe(false);
  });

  it("round-trips every answer kind through wireOf", () => {
    const answers: ModelAnswer[] = [
      { kind: "read_docs", urls: ["https://d.example/a"], note: "read" },
      { kind: "proceed", note: "go" },
      { kind: "give_up", reason: "no api" },
    ];
    for (const answer of answers) {
      const read = readWireAnswer(wireOf(answer), "proof");
      expect(read).toEqual({ ok: true, answer });
    }
    const written = readWireAnswer(draft, "goal");
    if (!written.ok) throw new Error("draft did not read");
    expect(readWireAnswer(wireOf(written.answer), "goal")).toEqual(written);
  });

  it("draftProblems is the publish's list, checked before anything is written", () => {
    expect(
      draftProblems({
        name: "ok-name",
        description: "d",
        inputSchema: { type: "object" },
        files: [{ path: "index.mjs", content: "" }],
        testInput: {},
        proofReads: [],
      }),
    ).toEqual([]);
  });
});
