import { describe, expect, it } from "vitest";

import type { RecordedRead, StockRecording } from "./recording";
import { keptLiteralsOf, ScrubFailure, scrubRecording, survivingValuesOf } from "./scrub";

/**
 * The scrub (GRA-257): a recording of a maintainer's own account, full of planted personal data,
 * comes out with none of it, every value the type and shape it was, and the same value the same
 * placeholder wherever it appears, so a later read naming an id from an earlier answer still does.
 */

const PLANTED = [
  "Alice Liddell",
  "alice.liddell@acme-corp.example",
  "bob@wonderland.example",
  "Quarterly numbers for Acme, confidential",
  "U04ABCDEF12",
  "5f2b8c1e-9a3d-4e7f-b6c2-1d0e8f7a9b3c",
  "https://files.acme-corp.example/private/board-minutes.pdf?sig=abc123",
  "+61 400 123 456",
  "2026-10-09",
  "2026-10-09T19:45:12.345Z",
  "2026-10-09T19:45",
  "Acme Pty Ltd",
];

const response = (json: unknown, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: { json },
});

const recording: StockRecording = {
  format: 1,
  tool: "slack__find-user",
  recordedAt: "2026-10-10T00:00:00.000Z",
  input: { email: "alice.liddell@acme-corp.example", limit: 5 },
  exchanges: [
    {
      kind: "read",
      method: "GET",
      url: "https://slack.com/api/users.lookupByEmail?email=alice.liddell%40acme-corp.example",
      response: response(
        {
          ok: true,
          user: {
            id: "U04ABCDEF12",
            real_name: "Alice Liddell",
            profile: {
              email: "alice.liddell@acme-corp.example",
              phone: "+61 400 123 456",
              avatar: "https://files.acme-corp.example/private/board-minutes.pdf?sig=abc123",
            },
            team: { name: "Acme Pty Ltd", uuid: "5f2b8c1e-9a3d-4e7f-b6c2-1d0e8f7a9b3c" },
            tz_offset: 36000,
            latitude: -37.8136,
            unread: 3,
            updated: "2026-10-09T19:45:12.345Z",
            joined: "2026-10-09",
            seen: "2026-10-09T19:45",
            manager: "bob@wonderland.example",
            status: "active",
            last_subject: "Quarterly numbers for Acme, confidential",
          },
        },
        { link: '<https://slack.com/api/users.list?cursor=dXNlcjpVMDRBQkNERUYxMg>; rel="next"' },
      ),
    },
    {
      kind: "read",
      method: "GET",
      url: "https://slack.com/api/conversations.history?channel=U04ABCDEF12&limit=5",
      response: response({ messages: [{ text: "Quarterly numbers for Acme, confidential" }] }),
    },
    {
      kind: "write",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { json: { channel: "U04ABCDEF12", text: "Hello from the stock tool" } },
    },
  ],
  result: { name: "Alice Liddell", id: "U04ABCDEF12", where: "Acme Pty Ltd", unread: 3 },
};

const SEED = "a-fixed-seed-for-this-suite";

function readOf(scrubbed: StockRecording, index: number): RecordedRead {
  return scrubbed.exchanges[index] as RecordedRead;
}

function userOf(scrubbed: StockRecording): Record<string, unknown> {
  const body = readOf(scrubbed, 0).response.body as { json: { user: Record<string, unknown> } };
  return body.json.user;
}

describe("scrubRecording", () => {
  it("leaves no planted value anywhere in the recording", () => {
    const text = JSON.stringify(scrubRecording(recording, { seed: SEED }));
    for (const planted of PLANTED) {
      expect(text, `${planted} survived`).not.toContain(planted);
      expect(decodeURIComponent(text), `${planted} survived encoded`).not.toContain(planted);
    }
    expect(text).not.toContain("Acme");
  });

  it("keeps every value's type and shape, every key, and every array's length", () => {
    const scrubbed = scrubRecording(recording, { seed: SEED });
    const user = userOf(scrubbed);
    const profile = user.profile as Record<string, string>;
    const team = user.team as Record<string, string>;

    expect(Object.keys(user)).toEqual(Object.keys(userOf(recording)));
    expect(user.real_name).toMatch(/^[A-Z][a-z]{4} [A-Z][a-z]{6}$/);
    expect(profile.email).toMatch(/^[a-z]{5}\.[a-z]{7}@example\.com$/);
    expect(user.manager).toMatch(/^[a-z]{3}@example\.com$/);
    expect(profile.phone).toMatch(/^\+\d{2} \d{3} \d{3} \d{3}$/);
    // A URL keeps its scheme and host and loses its path and query.
    expect(profile.avatar).toBe("https://files.acme-corp.example/");
    expect(team.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(user.id).toMatch(/^[A-Z]\d{2}[A-Z]{6}\d{2}$/);
    expect(user.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(user.updated as string))).toBe(false);
    expect(user.joined).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(user.joined as string))).toBe(false);
    expect(user.seen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect((readOf(scrubbed, 0).response.body as { json: { ok: unknown } }).json.ok).toBe(true);
    expect(Number.isInteger(user.tz_offset)).toBe(true);
    expect(String(user.tz_offset)).toHaveLength(5);
    expect(user.tz_offset).not.toBe(36000);
    expect(user.latitude).toBeLessThan(0);
    expect(String(user.latitude)).toMatch(/^-\d{2}\.\d{4}$/);
    expect(user.latitude).not.toBe(-37.8136);
    // A small count decides control flow and names no one.
    expect(user.unread).toBe(3);

    const second = readOf(scrubbed, 1).response.body as { json: { messages: unknown[] } };
    expect(second.json.messages).toHaveLength(1);
    expect(readOf(scrubbed, 0).response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(readOf(scrubbed, 0).response.headers.link).toBe('<https://slack.com/>; rel="next"');
  });

  it("maps one value to one placeholder across the input, the answers, the requests and the result", () => {
    const scrubbed = scrubRecording(recording, { seed: SEED });
    const user = userOf(scrubbed);
    const email = (user.profile as Record<string, string>).email;

    expect(scrubbed.input).toEqual({ email, limit: 5 });
    expect(new URL(readOf(scrubbed, 0).url).searchParams.get("email")).toBe(email);
    expect(new URL(readOf(scrubbed, 1).url).searchParams.get("channel")).toBe(user.id);
    // Constants of the module's own making are not values from an answer, and stay.
    expect(new URL(readOf(scrubbed, 1).url).pathname).toBe("/api/conversations.history");
    expect(scrubbed.exchanges[2]).toEqual({
      kind: "write",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { json: { channel: user.id, text: "Hello from the stock tool" } },
    });
    expect(scrubbed.result).toEqual({
      name: user.real_name,
      id: user.id,
      where: (user.team as Record<string, string>).name,
      unread: 3,
    });
    const messages = (
      readOf(scrubbed, 1).response.body as { json: { messages: { text: string }[] } }
    ).json.messages;
    expect(messages[0]?.text).toBe(user.last_subject);
    expect(user.last_subject).not.toBe(user.real_name);
  });

  it("is deterministic for a seed and differs across seeds", () => {
    expect(scrubRecording(recording, { seed: SEED })).toEqual(
      scrubRecording(recording, { seed: SEED }),
    );
    expect(userOf(scrubRecording(recording, { seed: "another" })).id).not.toBe(
      userOf(scrubRecording(recording, { seed: SEED })).id,
    );
  });

  it("keeps a value the module or its schema spells, and the redaction markers", () => {
    const scrubbed = scrubRecording(
      {
        ...recording,
        exchanges: [
          {
            kind: "read",
            method: "GET",
            url: "https://slack.com/api/x?token=%5Bredacted%5D",
            response: response({ status: "active", note: "seen [redacted:credential] here" }),
          },
        ],
      },
      { seed: SEED, keep: ["active"] },
    );
    const body = readOf(scrubbed, 0).response.body as { json: Record<string, string> };
    expect(body.json.status).toBe("active");
    expect(body.json.note).toMatch(/^[a-z]{4} \[redacted:credential\] [a-z]{4}$/);
    expect(readOf(scrubbed, 0).url).toBe("https://slack.com/api/x?token=%5Bredacted%5D");
  });

  it("scrubs a text and a binary body to the same length", () => {
    const scrubbed = scrubRecording(
      {
        ...recording,
        exchanges: [
          {
            kind: "read",
            method: "GET",
            url: "https://slack.com/a",
            response: { status: 200, headers: {}, body: { text: "Dear Alice Liddell," } },
          },
          {
            kind: "read",
            method: "GET",
            url: "https://slack.com/b",
            response: { status: 200, headers: {}, body: { base64: "QWxpY2UgTGlkZGVsbA==" } },
          },
        ],
      },
      { seed: SEED },
    );
    const text = (readOf(scrubbed, 0).response.body as { text: string }).text;
    expect(text).toMatch(/^[A-Z][a-z]{3} [A-Z][a-z]{4} [A-Z][a-z]{6},$/);
    const base64 = (readOf(scrubbed, 1).response.body as { base64: string }).base64;
    expect(Buffer.from(base64, "base64")).toHaveLength(13);
    expect(Buffer.from(base64, "base64").toString()).not.toContain("Alice");
  });
});

describe("scrubRecording, after Greptile on #192", () => {
  const withRead = (
    json: unknown,
    headers: Record<string, string> = {},
    input: Record<string, unknown> = {},
  ): StockRecording => ({
    ...recording,
    input,
    exchanges: [
      {
        kind: "read",
        method: "GET",
        url: "https://slack.com/a",
        response: response(json, headers),
      },
    ],
    result: null,
  });

  it("draws a link header's every parameter again but a safe rel, and the survival check reads it", () => {
    const link =
      '<https://api.example/private/acme?page=2>; rel="next"; title="Alice Liddell", ' +
      '<https://api.example/private/acme?page=9>; rel="last acme-secret"; x-acme-team=wonderland';
    const raw = withRead({}, { link });
    const scrubbed = scrubRecording(raw, { seed: SEED });
    const header = readOf(scrubbed, 0).response.headers.link as string;
    expect(header).toMatch(
      /^<https:\/\/api\.example\/>; rel="next"; title="[A-Z][a-z]{4} [A-Z][a-z]{6}", <https:\/\/api\.example\/>; rel="[a-z]{4} [a-z]{4}-[a-z]{6}"; [a-z]-[a-z]{4}-[a-z]{4}=[a-z]{10}$/,
    );
    for (const planted of ["Alice", "Liddell", "acme", "wonderland", "private"]) {
      expect(header).not.toContain(planted);
    }
    // A header that kept its title would be caught, though its target changed.
    const leaked = withRead(
      {},
      { link: '<https://api.example/>; rel="next"; title="Alice Liddell"' },
    );
    expect(survivingValuesOf(raw, leaked, { source: "" })).toEqual(["exchange 1"]);
    expect(survivingValuesOf(raw, scrubbed, { source: "" })).toEqual([]);
  });

  it("reads a link header with empty list members, keeping its safe rel", () => {
    const scrubbed = scrubRecording(
      withRead({}, { link: ' , <https://api.example/page/2>; rel="next",, ' }),
      { seed: SEED },
    );
    expect(readOf(scrubbed, 0).response.headers.link).toBe('<https://api.example/>; rel="next"');
  });

  it("reads a long hostile link header in linear time", () => {
    const link = `<>;${"\t;!=".repeat(20000)}`;
    const started = performance.now();
    const scrubbed = scrubRecording(withRead({}, { link }), { seed: SEED });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(readOf(scrubbed, 0).response.headers.link).toBeTypeOf("string");
  });

  it("scrubs a link header that does not parse as one string", () => {
    const scrubbed = scrubRecording(withRead({}, { link: "Alice Liddell, not a link" }), {
      seed: SEED,
    });
    expect(readOf(scrubbed, 0).response.headers.link).toMatch(
      /^[A-Z][a-z]{4} [A-Z][a-z]{6}, [a-z]{3} [a-z] [a-z]{4}$/,
    );
  });

  it("scrubs the text around a leading redaction marker, keeping the marker", () => {
    const raw = withRead({ note: "[redacted:credential] Alice Liddell", only: "[redacted]" });
    const scrubbed = scrubRecording(raw, { seed: SEED });
    const body = readOf(scrubbed, 0).response.body as { json: Record<string, string> };
    expect(body.json.note).toMatch(/^\[redacted:credential\] [A-Z][a-z]{4} [A-Z][a-z]{6}$/);
    expect(body.json.only).toBe("[redacted]");
    // The survival check looks for the text beside a marker, not only the whole string.
    const leaked = withRead({ note: "[redacted:credential] Alice Liddell", only: "[redacted]" });
    expect(survivingValuesOf(raw, leaked, { source: "" })).toEqual(["exchange 1"]);
    expect(survivingValuesOf(raw, scrubbed, { source: "" })).toEqual([]);
  });

  it("fails, naming where and never the value, when no placeholder can be drawn", () => {
    // Every one-digit negative number is an original value, so none can stand for another.
    const raw = withRead({ values: [-1, -2, -3, -4, -5, -6, -7, -8, -9] });
    let failure: unknown;
    try {
      scrubRecording(raw, { seed: SEED });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ScrubFailure);
    expect((failure as ScrubFailure).where).toBe("exchange 1's answer");
    expect((failure as ScrubFailure).message).toMatch(/no placeholder could be drawn/);
    expect((failure as ScrubFailure).message).not.toMatch(/-\d/);
  });

  it("never draws a number JSON cannot hold", () => {
    const scrubbed = scrubRecording(withRead({ huge: 1.5e308, big: -9.5e307 }), { seed: SEED });
    const body = readOf(scrubbed, 0).response.body as { json: Record<string, number> };
    expect(Number.isFinite(body.json.huge)).toBe(true);
    expect(Number.isFinite(body.json.big)).toBe(true);
    expect(body.json.huge).not.toBe(1.5e308);
  });

  it("draws the input's placeholders within its schema, and fails when the schema admits none", () => {
    const inputSchema = {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        size: { type: "number", minimum: 0.5, maximum: 2.5, multipleOf: 0.5 },
        sort: { enum: [250, 500] },
        code: { type: "string", pattern: "^AC-[0-9]{4}$" },
        short: { type: "string", minLength: 4, maxLength: 6 },
        email: { type: "string", format: "email" },
        when: { type: "string", format: "date-time" },
        site: { type: "string", format: "uri" },
        tags: { type: "array", items: { type: "string", maxLength: 8 } },
      },
    };
    const input = {
      limit: 100,
      size: 1.5,
      sort: 777,
      code: "AC-1234",
      short: "acme",
      email: "alice@acme-corp.example",
      when: "2026-10-09T19:45:12Z",
      site: "https://acme-corp.example/team",
      tags: ["Alice", "Liddell"],
    };
    const raw = withRead({ also: 100, sort: 500 }, {}, input);
    const scrubbed = scrubRecording(raw, { seed: SEED, inputSchema });
    const out = scrubbed.input as typeof input;
    expect(out.limit).toBeGreaterThanOrEqual(1);
    expect(out.limit).toBeLessThanOrEqual(100);
    expect(out.limit).not.toBe(100);
    expect([0.5, 1, 2, 2.5]).toContain(out.size);
    expect([250, 500]).toContain(out.sort);
    expect(out.code).toMatch(/^AC-\d{4}$/);
    expect(out.code).not.toBe("AC-1234");
    expect(out.short).toMatch(/^[a-z]{4}$/);
    expect(out.email).toMatch(/^[a-z]{5}@example\.com$/);
    expect(out.site).toBe("https://acme-corp.example/");
    expect(out.tags).toHaveLength(2);
    // The input's placeholder is the answer's too; the schema's enum number is public and stays.
    const body = readOf(scrubbed, 0).response.body as { json: Record<string, number> };
    expect(body.json.also).toBe(out.limit);
    expect(body.json.sort).toBe(500);

    // Bounds behind a `$ref` into the root's definitions are seen too.
    const referenced = scrubRecording(withRead({}, {}, { limit: 100, page: 50 }), {
      seed: SEED,
      inputSchema: {
        type: "object",
        $defs: { limit: { type: "integer", minimum: 1, maximum: 100 } },
        definitions: { page: { $ref: "#/$defs/limit", maximum: 60 } },
        properties: { limit: { $ref: "#/$defs/limit" }, page: { $ref: "#/definitions/page" } },
      },
    }).input as { limit: number; page: number };
    expect(referenced.limit).toBeGreaterThanOrEqual(1);
    expect(referenced.limit).toBeLessThanOrEqual(100);
    expect(referenced.limit).not.toBe(100);
    expect(referenced.page).toBeGreaterThanOrEqual(1);
    expect(referenced.page).toBeLessThanOrEqual(60);

    // `minimum` and `maximum` both 100 admit only the value itself, which is no placeholder.
    expect(() =>
      scrubRecording(withRead({}, {}, { limit: 100 }), {
        seed: SEED,
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 100, maximum: 100 } },
        },
      }),
    ).toThrow(/input schema admits.*in the input$/);
  });
});

describe("keptLiteralsOf", () => {
  it("reads the module's string literals, by a parse, and the schema's strings", () => {
    const kept = keptLiteralsOf(
      [
        {
          path: "index.ts",
          content: [
            'if (x.type === "message") return `a-$',
            '{x.kind === "file" ? "one" : y}-b`;\nconst z = \'it\\\'s\';\nconst n = "a\\nb";',
          ].join(""),
        },
      ],
      { type: "object", properties: { kind: { enum: ["open", "closed"] } } },
    );
    expect(kept).toEqual(
      expect.arrayContaining(["message", "a-", "file", "one", "-b", "it's", "a\nb", "open"]),
    );
    expect(kept).toContain("closed");
    expect(kept).not.toContain("anb");
  });
});

describe("survivingValuesOf", () => {
  it("names where a value from an answer survives, never the value", () => {
    const leaked = {
      ...scrubRecording(recording, { seed: SEED }),
      result: { name: "Alice Liddell" },
    };
    expect(survivingValuesOf(recording, leaked, { source: "" })).toEqual(["result"]);
    expect(
      survivingValuesOf(recording, scrubRecording(recording, { seed: SEED }), { source: "" }),
    ).toEqual([]);
  });

  it("does not read a website root as surviving inside its own placeholder", () => {
    const raw: StockRecording = {
      ...recording,
      input: {},
      exchanges: [
        {
          kind: "read",
          method: "GET",
          url: "https://api.github.com/x",
          response: response({ external_url: "https://app.example", home: "https://app.example/" }),
        },
      ],
      result: null,
    };
    const scrubbed = scrubRecording(raw, { seed: SEED });
    const body = readOf(scrubbed, 0).response.body as { json: Record<string, string> };
    expect(body.json.external_url).toBe("https://app.example/");
    expect(survivingValuesOf(raw, scrubbed, { source: "" })).toEqual([]);
  });
});
