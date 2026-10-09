type CalendarEvent = {
  status?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
};

type EventsPage = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

type Interval = { startMs: number; endMs: number };

function parseEventBoundary(
  value: { date?: string; dateTime?: string } | undefined,
): number | null {
  if (value?.dateTime) {
    const milliseconds = Date.parse(value.dateTime);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (value?.date) {
    const milliseconds = Date.parse(`${value.date}T00:00:00Z`);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  return null;
}

export default async (input: Input, ctx: Context) => {
  const calendarIds = input.calendarIds ?? ["primary"];
  const minMinutes = input.minMinutes ?? 30;
  const timeMinMs = input.timeMin === undefined ? Date.now() : Date.parse(input.timeMin);
  const timeMaxMs =
    input.timeMax === undefined ? timeMinMs + 7 * 24 * 60 * 60 * 1000 : Date.parse(input.timeMax);

  if (!Number.isFinite(timeMinMs)) throw new Error("timeMin must be a valid RFC 3339 date-time");
  if (!Number.isFinite(timeMaxMs)) throw new Error("timeMax must be a valid RFC 3339 date-time");
  if (timeMaxMs <= timeMinMs) throw new Error("timeMax must be later than timeMin");
  if (!Number.isInteger(minMinutes) || minMinutes < 1) {
    throw new Error("minMinutes must be a positive integer");
  }

  const timeMin = new Date(timeMinMs).toISOString();
  const timeMax = new Date(timeMaxMs).toISOString();
  const busy: Interval[] = [];

  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin,
        timeMax,
        maxResults: "2500",
      });
      if (pageToken) query.set("pageToken", pageToken);

      const path = `/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`;
      const res = await ctx.fetch(path);
      if (!res.ok)
        throw new Error(`GET events for calendar ${calendarId} ${res.status}: ${await res.text()}`);
      const page = (await res.json()) as EventsPage;

      for (const event of page.items ?? []) {
        if (event.status === "cancelled" || event.transparency === "transparent") continue;
        if (
          event.attendees?.some(
            (attendee) => attendee.self === true && attendee.responseStatus === "declined",
          )
        )
          continue;

        const eventStart = parseEventBoundary(event.start);
        const eventEnd = parseEventBoundary(event.end);
        if (eventStart === null || eventEnd === null || eventEnd <= eventStart) continue;

        const startMs = Math.max(eventStart, timeMinMs);
        const endMs = Math.min(eventEnd, timeMaxMs);
        if (endMs > startMs) busy.push({ startMs, endMs });
      }

      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  busy.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Interval[] = [];
  for (const interval of busy) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }

  const free: Interval[] = [];
  let cursor = timeMinMs;
  for (const interval of merged) {
    if (interval.startMs > cursor) free.push({ startMs: cursor, endMs: interval.startMs });
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < timeMaxMs) free.push({ startMs: cursor, endMs: timeMaxMs });

  return {
    window: { start: timeMin, end: timeMax },
    busyIntervals: merged.map((interval) => ({
      start: new Date(interval.startMs).toISOString(),
      end: new Date(interval.endMs).toISOString(),
    })),
    freeSlots: free
      .filter((interval) => interval.endMs - interval.startMs >= minMinutes * 60 * 1000)
      .map((interval) => ({
        start: new Date(interval.startMs).toISOString(),
        end: new Date(interval.endMs).toISOString(),
        minutes: (interval.endMs - interval.startMs) / 60000,
      })),
  };
};
