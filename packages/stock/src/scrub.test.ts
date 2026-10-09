import { describe, expect, it } from "vitest";

import type { RecordedRead, StockRecording } from "./recording";
import { keptLiteralsOf, scrubRecording, survivingValuesOf } from "./scrub";

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

describe("keptLiteralsOf", () => {
  it("reads the module's string literals and the schema's strings", () => {
    const kept = keptLiteralsOf(
      [
        {
          content: ['if (x.type === "message") return `a-$', "{y}-b`;\nconst z = 'it\\'s';"].join(
            "",
          ),
        },
      ],
      { type: "object", properties: { kind: { enum: ["open", "closed"] } } },
    );
    expect(kept).toEqual(expect.arrayContaining(["message", "a-", "-b", "it's", "open", "closed"]));
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

  it("does not count a bare origin as surviving inside its own placeholder (GRA-253)", () => {
    const withOrigin: StockRecording = {
      ...recording,
      exchanges: [
        {
          kind: "read",
          method: "GET",
          url: "https://api.github.com/repos/o/r/issues/1/comments",
          response: response([{ app: { external_url: "https://linear.app" } }]),
        },
      ],
    };
    const scrubbed = scrubRecording(withOrigin, { seed: SEED });
    expect(JSON.stringify(scrubbed.exchanges)).toContain('"https://linear.app/"');
    expect(survivingValuesOf(withOrigin, scrubbed, { source: "" })).toEqual([]);
  });
});
