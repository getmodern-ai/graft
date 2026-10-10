import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Google Calendar's stock modules over a fake `ctx.fetch` (GRA-249, Greptile on #194). The
 * recordings prove each module against the vendor's real answer shape; these cases cover what a
 * recording cannot reach: `find-free-time`'s arithmetic over synthetic busy periods, the `If-Match`
 * retry of the two tools that write a guest list back whole, and that every call names the Calendar
 * API's own path on its host, whichever Google connection's base path it runs over.
 */

type Call = { path: string; init: RequestInit & { host?: string } };
type Module = (input: unknown, ctx: unknown) => Promise<unknown>;

async function load(name: string): Promise<Module> {
  const url = new URL(`../tools/google-calendar/${name}/index.ts`, import.meta.url);
  const specifier: string = fileURLToPath(url);
  return ((await import(specifier)) as { default: Module }).default;
}

function fakeCtx(answer: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const ctx = {
    fetch: async (path: string, init: RequestInit & { host?: string } = {}) => {
      const call = { path, init };
      calls.push(call);
      return answer(call, calls.length - 1);
    },
  };
  return { ctx, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const at = (time: string) => ({ dateTime: `2001-01-01T${time}:00Z` });

describe("google-calendar__find-free-time", () => {
  it("merges overlapping busy periods across pages and calendars, skipping what does not block", async () => {
    const run = await load("find-free-time");
    const pages: Record<string, unknown> = {
      "primary:": {
        items: [
          { start: at("09:00"), end: at("10:00") },
          { start: at("09:30"), end: at("10:30") },
          { start: at("11:00"), end: at("11:15"), transparency: "transparent" },
          { start: at("11:00"), end: at("11:30"), status: "cancelled" },
          {
            start: at("12:00"),
            end: at("13:00"),
            attendees: [{ self: true, responseStatus: "declined" }],
          },
        ],
        nextPageToken: "next",
      },
      "primary:next": {
        // Starts before the window and ends inside it; clamped to the window's start.
        items: [{ start: { dateTime: "2000-12-31T23:00:00Z" }, end: at("08:30") }],
      },
      "team:": {
        // Ends after the window; clamped to its end.
        items: [
          { start: at("14:00"), end: at("14:20") },
          { start: at("16:30"), end: { dateTime: "2001-01-01T20:00:00Z" } },
        ],
      },
    };
    const { ctx, calls } = fakeCtx((call) => {
      const url = new URL(call.path, "https://x.invalid");
      const calendar = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      return json(pages[`${calendar}:${url.searchParams.get("pageToken") ?? ""}`]);
    });

    const result = await run(
      {
        calendarIds: ["primary", "team"],
        timeMin: "2001-01-01T08:00:00Z",
        timeMax: "2001-01-01T17:00:00Z",
        minMinutes: 30,
      },
      ctx,
    );

    expect(calls).toHaveLength(3);
    expect(result).toEqual({
      window: { start: "2001-01-01T08:00:00.000Z", end: "2001-01-01T17:00:00.000Z" },
      busyIntervals: [
        { start: "2001-01-01T08:00:00.000Z", end: "2001-01-01T08:30:00.000Z" },
        { start: "2001-01-01T09:00:00.000Z", end: "2001-01-01T10:30:00.000Z" },
        { start: "2001-01-01T14:00:00.000Z", end: "2001-01-01T14:20:00.000Z" },
        { start: "2001-01-01T16:30:00.000Z", end: "2001-01-01T17:00:00.000Z" },
      ],
      // 08:30 to 09:00 is exactly the minimum and kept; 14:20 to 16:30 is kept; nothing shorter
      // than thirty minutes is offered.
      freeSlots: [
        { start: "2001-01-01T08:30:00.000Z", end: "2001-01-01T09:00:00.000Z", minutes: 30 },
        { start: "2001-01-01T10:30:00.000Z", end: "2001-01-01T14:00:00.000Z", minutes: 210 },
        { start: "2001-01-01T14:20:00.000Z", end: "2001-01-01T16:30:00.000Z", minutes: 130 },
      ],
    });
  });

  it("drops a gap shorter than the minimum", async () => {
    const run = await load("find-free-time");
    const { ctx } = fakeCtx(() =>
      json({
        items: [
          { start: at("08:00"), end: at("09:00") },
          { start: at("09:20"), end: at("10:00") },
        ],
      }),
    );
    const result = (await run(
      { timeMin: "2001-01-01T08:00:00Z", timeMax: "2001-01-01T10:00:00Z", minMinutes: 30 },
      ctx,
    )) as { freeSlots: unknown[] };
    expect(result.freeSlots).toEqual([]);
  });
});

describe("google-calendar__update-event", () => {
  it("names the etag it read and rebuilds the guest list from a fresh read on 412", async () => {
    const run = await load("update-event");
    const reads = [
      { etag: '"v1"', attendees: [{ email: "a@example.com" }] },
      { etag: '"v2"', attendees: [{ email: "a@example.com" }, { email: "late@example.com" }] },
    ];
    let read = 0;
    const { ctx, calls } = fakeCtx((call) => {
      if (call.init.method !== "PATCH") return json(reads[read++]);
      const ifMatch = (call.init.headers as Record<string, string>)["if-match"];
      if (ifMatch === '"v1"') return json({ error: { code: 412 } }, 412);
      return json({ id: "e1", attendees: JSON.parse(String(call.init.body)).attendees });
    });

    const result = await run({ eventId: "e1", addAttendees: ["new@example.com"] }, ctx);

    expect(calls.map((call) => call.init.method ?? "GET")).toEqual([
      "GET",
      "PATCH",
      "GET",
      "PATCH",
    ]);
    expect(new Headers(calls[3]?.init.headers).get("if-match")).toBe('"v2"');
    expect(result).toMatchObject({
      attendeeEmails: ["a@example.com", "late@example.com", "new@example.com"],
    });
  });

  it("gives up after three stale writes rather than looping", async () => {
    const run = await load("update-event");
    const { ctx, calls } = fakeCtx((call) =>
      call.init.method === "PATCH"
        ? json({ error: { code: 412 } }, 412)
        : json({ etag: '"v"', attendees: [] }),
    );
    await expect(run({ eventId: "e1", addAttendees: ["n@example.com"] }, ctx)).rejects.toThrow(
      /PATCH event 412/,
    );
    expect(calls).toHaveLength(6);
  });
});

describe("google-calendar__update-event's boundaries", () => {
  it("clears the other form when a boundary moves between a time and a whole day (Greptile on #194)", async () => {
    const run = await load("update-event");
    const { ctx, calls } = fakeCtx(() => json({ id: "evt_1" }));
    await run({ eventId: "evt_1", start: "2001-01-02", end: "2001-01-03" }, ctx);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      start: { date: "2001-01-02", dateTime: null },
      end: { date: "2001-01-03", dateTime: null },
    });
    await run(
      { eventId: "evt_1", start: "2001-01-02T09:00:00Z", end: "2001-01-02T10:00:00Z" },
      ctx,
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      start: { dateTime: "2001-01-02T09:00:00Z", date: null },
      end: { dateTime: "2001-01-02T10:00:00Z", date: null },
    });
  });
});

describe("google-calendar__respond-to-event", () => {
  it("names the etag it read and reads the guest list again on 412", async () => {
    const run = await load("respond-to-event");
    const reads = [
      { id: "e1", etag: '"v1"', attendees: [{ email: "me@example.com", self: true }] },
      {
        id: "e1",
        etag: '"v2"',
        attendees: [
          { email: "me@example.com", self: true },
          { email: "other@example.com", responseStatus: "accepted" },
        ],
      },
    ];
    let read = 0;
    const patches: unknown[] = [];
    const { ctx, calls } = fakeCtx((call) => {
      if (call.init.method !== "PATCH") return json(reads[read++]);
      patches.push(JSON.parse(String(call.init.body)));
      const ifMatch = (call.init.headers as Record<string, string>)["if-match"];
      return ifMatch === '"v1"' ? json({}, 412) : json({ id: "e1" });
    });

    await run({ eventId: "e1", response: "accepted" }, ctx);

    expect(calls).toHaveLength(4);
    expect(patches[1]).toEqual({
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
        { email: "other@example.com", responseStatus: "accepted" },
      ],
    });
  });
});

describe("every Google Calendar stock tool", () => {
  const cases: [string, unknown][] = [
    ["list-calendars", {}],
    ["list-events", { timeMin: "2001-01-01T00:00:00Z" }],
    ["get-event", { eventId: "e1" }],
    ["find-free-time", { timeMin: "2001-01-01T00:00:00Z" }],
    ["create-event", { summary: "s", start: "2001-01-01", end: "2001-01-02" }],
    ["update-event", { eventId: "e1", summary: "s", addAttendees: ["a@example.com"] }],
    ["delete-event", { eventId: "e1" }],
    ["respond-to-event", { eventId: "e1", response: "accepted" }],
  ];

  it.each(cases)(
    "%s calls the Calendar API's own path on www.googleapis.com, not the connection's base",
    async (name, input) => {
      const run = await load(name);
      const { ctx, calls } = fakeCtx((call) =>
        call.init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({ id: "e1", items: [], attendees: [{ email: "me@example.com", self: true }] }),
      );
      await run(input, ctx);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.init.host).toBe("www.googleapis.com");
        expect(call.path.startsWith("/calendar/v3/")).toBe(true);
      }
    },
  );
});
