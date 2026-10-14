import { describe, expect, it } from "vitest";

/**
 * Microsoft Outlook's `find-free-time` over a busy calendar (GRA-268, Greptile on #206). Its
 * recording is an empty calendar, the only one the build account had, so the replay never
 * subtracts an event; these cases run the module itself over a fake calendar view. The module is
 * imported by a computed path: `tools/` is outside this package's type program, since a module's
 * `Input` and `Context` are the check's declarations.
 */
const MODULE = new URL("../tools/microsoft-outlook/find-free-time/index.ts", import.meta.url).href;

type Slot = { start: string; end: string; timeZone: string };
type CalendarEvent = {
  start: string;
  end: string;
  showAs?: string;
  isCancelled?: boolean;
};

async function freeTime(input: Record<string, unknown>, events: CalendarEvent[]) {
  const { default: run } = (await import(/* @vite-ignore */ MODULE)) as {
    default: (input: unknown, ctx: unknown) => Promise<{ slots: Slot[] }>;
  };
  const requests: string[] = [];
  const ctx = {
    fetch: async (path: string) => {
      requests.push(path);
      const value = events.map((event) => ({
        start: { dateTime: event.start, timeZone: "UTC" },
        end: { dateTime: event.end, timeZone: "UTC" },
        showAs: event.showAs ?? "busy",
        isCancelled: event.isCancelled ?? false,
      }));
      return new Response(JSON.stringify({ value }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const result = await run(input, ctx);
  return { slots: result.slots, requests };
}

// Monday 6 and Tuesday 7 January 2020.
const WINDOW = { start: "2020-01-06T00:00:00Z", end: "2020-01-08T00:00:00Z" };

describe("microsoft-outlook__find-free-time over a busy calendar", () => {
  it("subtracts overlapping events and keeps gaps of the duration", async () => {
    const { slots, requests } = await freeTime({ ...WINDOW, durationMinutes: 30 }, [
      { start: "2020-01-06T10:00:00.0000000", end: "2020-01-06T11:00:00.0000000" },
      { start: "2020-01-06T10:30:00.0000000", end: "2020-01-06T12:00:00.0000000" },
      // A 20-minute gap, shorter than the duration, is not offered.
      { start: "2020-01-06T12:20:00.0000000", end: "2020-01-06T16:45:00.0000000" },
    ]);
    expect(requests).toHaveLength(1);
    expect(slots.filter((slot) => slot.start.startsWith("2020-01-06"))).toEqual([
      { start: "2020-01-06T09:00:00", end: "2020-01-06T10:00:00", timeZone: "UTC" },
    ]);
  });

  it("clips events that cross the working day's edges", async () => {
    const { slots } = await freeTime({ ...WINDOW, durationMinutes: 30 }, [
      { start: "2020-01-06T07:00:00.0000000", end: "2020-01-06T09:30:00.0000000" },
      { start: "2020-01-06T16:30:00.0000000", end: "2020-01-06T19:00:00.0000000" },
    ]);
    expect(slots[0]).toEqual({
      start: "2020-01-06T09:30:00",
      end: "2020-01-06T16:30:00",
      timeZone: "UTC",
    });
  });

  it("treats cancelled events and those shown as free as not busy", async () => {
    const { slots } = await freeTime({ ...WINDOW, durationMinutes: 30 }, [
      { start: "2020-01-06T09:00:00.0000000", end: "2020-01-06T17:00:00.0000000", showAs: "free" },
      {
        start: "2020-01-07T09:00:00.0000000",
        end: "2020-01-07T17:00:00.0000000",
        isCancelled: true,
      },
    ]);
    expect(slots).toEqual([
      { start: "2020-01-06T09:00:00", end: "2020-01-06T17:00:00", timeZone: "UTC" },
      { start: "2020-01-07T09:00:00", end: "2020-01-07T17:00:00", timeZone: "UTC" },
    ]);
  });

  it("reads working hours at the offset given, and answers in UTC", async () => {
    // 09:00 to 17:00 at UTC+10 is 23:00 to 07:00 UTC the day before; a meeting at 01:00 UTC
    // (11:00 local) splits the Tuesday-local day.
    const { slots } = await freeTime(
      {
        start: "2020-01-06T14:00:00Z",
        end: "2020-01-07T14:00:00Z",
        durationMinutes: 30,
        utcOffsetMinutes: 600,
      },
      [{ start: "2020-01-07T01:00:00.0000000", end: "2020-01-07T02:00:00.0000000" }],
    );
    expect(slots).toEqual([
      { start: "2020-01-06T23:00:00", end: "2020-01-07T01:00:00", timeZone: "UTC" },
      { start: "2020-01-07T02:00:00", end: "2020-01-07T07:00:00", timeZone: "UTC" },
    ]);
  });

  it("refuses an offset no zone has, which would stop the day loop advancing", async () => {
    await expect(freeTime({ ...WINDOW, utcOffsetMinutes: 1e30 }, [])).rejects.toThrow(
      "utcOffsetMinutes must be an integer from -720 to 840",
    );
    await expect(freeTime({ ...WINDOW, utcOffsetMinutes: -721 }, [])).rejects.toThrow(
      "utcOffsetMinutes",
    );
  });
});
