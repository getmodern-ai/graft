type GraphDateTime = {
  dateTime?: string;
  timeZone?: string;
};

type GraphEvent = {
  start?: GraphDateTime;
  end?: GraphDateTime;
  showAs?: string;
  isCancelled?: boolean;
};

type GraphResponse = {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
};

type Interval = {
  start: number;
  end: number;
};

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

function parseInputDate(value: string, field: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${field} must include Z or a UTC offset`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} is not a valid ISO 8601 date-time`);
  return parsed;
}

function parseGraphDate(value: GraphDateTime | undefined, field: string): number {
  const raw = value?.dateTime;
  if (typeof raw !== "string") throw new Error(`Calendar event has no valid ${field}.dateTime`);
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(withZone);
  if (!Number.isFinite(parsed)) throw new Error(`Calendar event has an invalid ${field}.dateTime`);
  return parsed;
}

function formatUtcLocalDateTime(value: number): string {
  return new Date(value).toISOString().slice(0, 19);
}

export default async (input: Input, ctx: Context) => {
  const windowStart = parseInputDate(input.start, "start");
  const windowEnd = parseInputDate(input.end, "end");
  if (windowEnd <= windowStart) throw new Error("end must be later than start");

  const durationMinutes = input.durationMinutes ?? 30;
  const workdayStartHour = input.workdayStartHour ?? 9;
  const workdayEndHour = input.workdayEndHour ?? 17;
  const utcOffsetMinutes = input.utcOffsetMinutes ?? 0;
  const includeWeekends = input.includeWeekends ?? false;

  if (workdayEndHour <= workdayStartHour) {
    throw new Error("workdayEndHour must be later than workdayStartHour");
  }

  const query = new URLSearchParams({
    startDateTime: input.start,
    endDateTime: input.end,
    $orderby: "start/dateTime",
    $top: "500",
    $select: "start,end,showAs,isCancelled",
  });
  const path = `/me/calendar/calendarView?${query.toString()}`;
  const res = await ctx.fetch(path, {
    method: "GET",
    headers: { Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) throw new Error(`GET /me/calendar/calendarView ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as GraphResponse;
  if (!Array.isArray(data.value)) {
    throw new Error("GET /me/calendar/calendarView returned no event collection");
  }
  if (data["@odata.nextLink"]) {
    throw new Error(
      "The calendar view contains more than 500 events; no free slots were returned from an incomplete view",
    );
  }

  const busy: Interval[] = [];
  for (const event of data.value) {
    if (event.isCancelled === true || event.showAs === "free") continue;
    const start = parseGraphDate(event.start, "start");
    const end = parseGraphDate(event.end, "end");
    if (end > start && end > windowStart && start < windowEnd) {
      busy.push({ start: Math.max(start, windowStart), end: Math.min(end, windowEnd) });
    }
  }
  busy.sort((a, b) => a.start - b.start || a.end - b.end);

  const minimumMs = durationMinutes * minuteMs;
  const offsetMs = utcOffsetMinutes * minuteMs;
  const firstLocalDay = Math.floor((windowStart + offsetMs) / dayMs) * dayMs;
  const lastLocalDay = Math.floor((windowEnd - 1 + offsetMs) / dayMs) * dayMs;
  const slots: Array<{ start: string; end: string; timeZone: "UTC" }> = [];

  for (
    let localDay = firstLocalDay;
    localDay <= lastLocalDay && slots.length < 20;
    localDay += dayMs
  ) {
    const weekday = new Date(localDay).getUTCDay();
    if (!includeWeekends && (weekday === 0 || weekday === 6)) continue;

    const workStart = Math.max(windowStart, localDay + workdayStartHour * hourMs - offsetMs);
    const workEnd = Math.min(windowEnd, localDay + workdayEndHour * hourMs - offsetMs);
    if (workEnd - workStart < minimumMs) continue;

    let cursor = workStart;
    for (const interval of busy) {
      if (interval.end <= cursor) continue;
      if (interval.start >= workEnd) break;
      const busyStart = Math.max(interval.start, workStart);
      if (busyStart - cursor >= minimumMs) {
        slots.push({
          start: formatUtcLocalDateTime(cursor),
          end: formatUtcLocalDateTime(busyStart),
          timeZone: "UTC",
        });
        if (slots.length >= 20) break;
      }
      cursor = Math.max(cursor, Math.min(interval.end, workEnd));
      if (cursor >= workEnd) break;
    }
    if (slots.length < 20 && workEnd - cursor >= minimumMs) {
      slots.push({
        start: formatUtcLocalDateTime(cursor),
        end: formatUtcLocalDateTime(workEnd),
        timeZone: "UTC",
      });
    }
  }

  return { slots };
};
