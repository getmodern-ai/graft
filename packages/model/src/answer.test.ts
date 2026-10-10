import { describe, expect, it } from "vitest";

import {
  draftProblems,
  MAX_PROOF_READ_BODY_CHARS,
  MAX_PROOF_READ_HEADER_VALUE_CHARS,
  MAX_PROOF_READ_HEADERS,
  MAX_PROOF_READS,
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
  proofReads: [],
  draft: {
    name: "create-order",
    description: "Creates an order for one item and a quantity.",
    inputSchemaJson:
      '{"type":"object","properties":{"itemId":{"type":"string"}},"required":["itemId"]}',
    files: [
      { path: "index.ts", content: "export default async (input: Input, ctx: Context) => ({})" },
    ],
    testInputJson: '{"itemId":"itm_a"}',
    proofReads: [
      { path: "/items?limit=1", host: null, method: null, headers: [], body: null },
      {
        path: "/v1/search?name=Berlin",
        host: " Geocoding.Demo.example ",
        method: null,
        headers: [],
        body: null,
      },
    ],
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
          // GRA-213: a null host is the primary's and drops away; a named one is trimmed and lower-cased.
          proofReads: [
            { path: "/items?limit=1" },
            { path: "/v1/search?name=Berlin", host: "geocoding.demo.example" },
          ],
        },
      },
    });
  });

  it("refuses a kind the situation does not admit, naming the admitted ones", () => {
    const read = readWireAnswer(
      { kind: "proceed", note: "ok", urls: [], proofReads: [], draft: null },
      "check_refused",
    );
    expect(read).toEqual({
      ok: false,
      problems: [
        '"proceed" does not answer a "check_refused" situation; answer with one of read_docs, write_module, give_up',
      ],
    });
    expect(
      readWireAnswer(
        { kind: "proceed", note: "ok", urls: [], proofReads: [], draft: null },
        "proof",
      ),
    ).toEqual({ ok: true, answer: { kind: "proceed", note: "ok" } });
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
          proofReads: [
            { path: "items", host: null, method: null, headers: [], body: null },
            {
              path: "/v1/search",
              host: "geocoding.demo.example/v1",
              method: null,
              headers: [],
              body: null,
            },
          ],
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
      'proof read "items" is not a vendor-relative path; give the path from the host\'s root, starting with /, and name another host the connection declares in "host"',
      'proof read host "geocoding.demo.example/v1" is not a host name; name one of the connection\'s hosts, such as api.example.com, or null for the primary',
    ]);
    expect(read.problems).not.toContain("testInput is not an object");
  });

  it("refuses read_docs without a usable URL, and give_up without a reason", () => {
    expect(
      readWireAnswer(
        { kind: "read_docs", note: "n", urls: [" "], proofReads: [], draft: null },
        "goal",
      ),
    ).toEqual({
      ok: false,
      problems: ["read_docs names no URL to read"],
    });
    expect(
      readWireAnswer(
        { kind: "read_docs", note: "n", urls: ["ftp://x", "docs"], proofReads: [], draft: null },
        "goal",
      ),
    ).toEqual({
      ok: false,
      problems: ['"ftp://x" is not an http(s) URL', '"docs" is not an http(s) URL'],
    });
    expect(
      readWireAnswer({ kind: "give_up", note: "", urls: [], proofReads: [], draft: null }, "goal"),
    ).toEqual({
      ok: false,
      problems: ["give_up carries no reason in note"],
    });
    expect(
      readWireAnswer(
        { kind: "give_up", note: "No API.", urls: [], proofReads: [], draft: null },
        "goal",
      ),
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
  /** Greptile on graft #114: the protocol asks for every path, so a list over the cap is repaired, not cut. */
  it("refuses more proof reads than the job runs, naming both numbers", () => {
    const many = readWireAnswer(
      {
        ...draft,
        draft: {
          ...draft.draft,
          proofReads: ["/a", "/b", "/c", "/d", "/e", "/f"].map((path) => ({
            path,
            host: null,
            method: null,
            headers: [],
            body: null,
          })),
        } as NonNullable<WireAnswer["draft"]>,
      },
      "goal",
    );
    expect(MAX_PROOF_READS).toBe(5);
    expect(many).toEqual({
      ok: false,
      problems: [
        "proofReads names 6 paths and the job runs at most 5; keep the ones whose answers the module parses",
      ],
    });
  });

  /** GRA-271: the vendor's own headers, and a read POST with its body, round-trip through the wire. */
  it("reads a proof read's headers, method and body, and writes them back in wire form", () => {
    const wire: WireAnswer = {
      kind: "prove",
      note: "the search the module makes",
      urls: [],
      proofReads: [
        {
          path: "/v1/search",
          host: null,
          method: "POST",
          headers: [{ name: " Notion-Version ", value: " 2022-06-28 " }],
          body: '{"page_size":1}',
        },
        { path: "/v1/users/me", host: null, method: "GET", headers: [], body: null },
      ],
      draft: null,
    };
    const read = readWireAnswer(wire, "proof");
    const answer: ModelAnswer = {
      kind: "prove",
      note: "the search the module makes",
      proofReads: [
        {
          path: "/v1/search",
          method: "POST",
          headers: { "notion-version": "2022-06-28" },
          body: '{"page_size":1}',
        },
        { path: "/v1/users/me" },
      ],
    };
    expect(read).toEqual({ ok: true, answer });
    expect(wireOf(answer).proofReads).toEqual([
      {
        path: "/v1/search",
        host: null,
        method: "POST",
        headers: [{ name: "notion-version", value: "2022-06-28" }],
        body: '{"page_size":1}',
      },
      { path: "/v1/users/me", host: null, method: null, headers: [], body: null },
    ]);
    expect(WIRE_ANSWER_SCHEMA.safeParse(wireOf(answer)).success).toBe(true);
  });

  /** GRA-271: a header the proxy owns, a body on a GET, and the caps are each repaired with a sentence. */
  it("refuses a credential header, a malformed one, a body without POST and a read over the caps", () => {
    const prove = (read: Partial<WireAnswer["proofReads"][number]>): WireAnswer => ({
      kind: "prove",
      note: "n",
      urls: [],
      proofReads: [
        { path: "/v1/search", host: null, method: null, headers: [], body: null, ...read },
      ],
      draft: null,
    });
    const problems = (read: Partial<WireAnswer["proofReads"][number]>) => {
      const answer = readWireAnswer(prove(read), "proof");
      return answer.ok ? [] : answer.problems;
    };
    for (const name of [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "Host",
      "Proxy-Foo",
      "X-Graft-Token",
    ]) {
      expect(problems({ headers: [{ name, value: "v" }] })).toEqual([
        expect.stringContaining(
          `proof read header "${name.toLowerCase()}" is not a proof read's to send`,
        ),
      ]);
    }
    expect(problems({ headers: [{ name: "Notion Version", value: "v" }] })).toEqual([
      expect.stringContaining('proof read header "notion version" is not a header name'),
    ]);
    expect(problems({ headers: [{ name: "Notion-Version", value: "a\u0000b" }] })).toEqual([
      expect.stringContaining("a line break or a control character"),
    ]);
    expect(
      problems({
        headers: [
          { name: "Notion-Version", value: "1" },
          { name: "notion-version", value: "2" },
        ],
      }),
    ).toEqual([expect.stringContaining('names header "notion-version" twice')]);
    expect(problems({ body: "{}" })).toEqual([
      expect.stringContaining("carries a body without method POST"),
    ]);
    expect(
      problems({
        headers: Array.from({ length: MAX_PROOF_READ_HEADERS + 1 }, (_, i) => ({
          name: `x-h${i}`,
          value: "v",
        })),
      }),
    ).toEqual([expect.stringContaining(`at most ${MAX_PROOF_READ_HEADERS}`)]);
    expect(
      problems({
        headers: [{ name: "x-h", value: "v".repeat(MAX_PROOF_READ_HEADER_VALUE_CHARS + 1) }],
      }),
    ).toEqual([expect.stringContaining(`at most ${MAX_PROOF_READ_HEADER_VALUE_CHARS}`)]);
    expect(problems({ method: "POST", body: "x".repeat(MAX_PROOF_READ_BODY_CHARS + 1) })).toEqual([
      expect.stringContaining(`at most ${MAX_PROOF_READ_BODY_CHARS}`),
    ]);
    expect(problems({ method: "POST", body: '{"query":"{ viewer { id } }"}' })).toEqual([]);
  });

  /** GRA-153: more reads against the current draft, a turn and not an attempt. */
  it("reads a prove with its paths, and refuses one with none, one off the vendor, or more than an attempt runs", () => {
    const prove = (paths: string[], note = "the id the list returned"): WireAnswer => ({
      kind: "prove",
      note,
      urls: [],
      proofReads: paths.map((path) => ({
        path,
        host: null,
        method: null,
        headers: [],
        body: null,
      })),
      draft: null,
    });
    expect(readWireAnswer(prove([" /items/itm_1 ", ""]), "proof")).toEqual({
      ok: true,
      answer: {
        kind: "prove",
        proofReads: [{ path: "/items/itm_1" }],
        note: "the id the list returned",
      },
    });
    // GRA-213: a read on another declared host carries it; one whose host is not a host name is repaired.
    expect(
      readWireAnswer(
        {
          ...prove([]),
          proofReads: [
            {
              path: "/v1/search",
              host: "geocoding.demo.example",
              method: null,
              headers: [],
              body: null,
            },
          ],
        },
        "proof",
      ),
    ).toEqual({
      ok: true,
      answer: {
        kind: "prove",
        proofReads: [{ path: "/v1/search", host: "geocoding.demo.example" }],
        note: "the id the list returned",
      },
    });
    expect(
      readWireAnswer(
        {
          ...prove([]),
          proofReads: [
            {
              path: "/v1/search",
              host: "https://geocoding.demo.example",
              method: null,
              headers: [],
              body: null,
            },
          ],
        },
        "proof",
      ),
    ).toMatchObject({
      ok: false,
      problems: [
        expect.stringContaining(
          'proof read host "https://geocoding.demo.example" is not a host name',
        ),
      ],
    });
    expect(readWireAnswer(prove([]), "proof")).toEqual({
      ok: false,
      problems: ["prove names no path to read"],
    });
    expect(readWireAnswer(prove(["https://api.demo.example/items"]), "proof")).toEqual({
      ok: false,
      problems: [
        expect.stringContaining(
          'proof read "https://api.demo.example/items" is not a vendor-relative path',
        ),
      ],
    });
    expect(readWireAnswer(prove(["/a", "/b", "/c", "/d", "/e", "/f"]), "proof")).toEqual({
      ok: false,
      problems: ["prove names 6 paths and an attempt runs at most 5 in all"],
    });
    // Only a proof result admits it.
    expect(readWireAnswer(prove(["/items/itm_1"]), "goal")).toMatchObject({ ok: false });
  });

  it("is what structured output can hold: every property present, the free-form values as text", () => {
    const parsed = WIRE_ANSWER_SCHEMA.safeParse(draft);
    expect(parsed.success).toBe(true);
    expect(WIRE_ANSWER_SCHEMA.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(WIRE_ANSWER_SCHEMA.safeParse({ kind: "proceed", note: "ok" }).success).toBe(false);
  });

  it("round-trips every answer kind through wireOf", () => {
    const answers: ModelAnswer[] = [
      { kind: "read_docs", urls: ["https://d.example/a"], note: "read" },
      { kind: "prove", proofReads: [{ path: "/items/itm_1" }], note: "the id the list returned" },
      {
        kind: "prove",
        proofReads: [{ path: "/v1/search?name=Berlin", host: "geocoding.demo.example" }],
        note: "the geocoding host",
      },
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
