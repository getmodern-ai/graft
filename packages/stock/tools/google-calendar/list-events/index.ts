type EventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type EventAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
};

type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  htmlLink?: string;
  organizer?: { email?: string };
  attendees?: EventAttendee[];
  hangoutLink?: string;
};

type EventsListResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

function eventTime(value: EventDateTime | undefined) {
  return {
    dateTime: value?.dateTime ?? null,
    date: value?.date ?? null,
    timeZone: value?.timeZone ?? null,
  };
}

export default async (input: Input, ctx: Context) => {
  const calendarId = input.calendarId ?? "primary";
  const timeMin = input.timeMin ?? new Date().toISOString();
  const timeMax =
    input.timeMax ?? new Date(new Date(timeMin).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const limit = input.maxResults ?? 50;
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set("singleEvents", "true");
    params.set("orderBy", "startTime");
    params.set("timeMin", timeMin);
    params.set("timeMax", timeMax);
    params.set("maxResults", String(limit - events.length));
    if (input.query !== undefined) params.set("q", input.query);
    if (pageToken !== undefined) params.set("pageToken", pageToken);

    const path = `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    const res = await ctx.fetch(path);
    if (!res.ok) throw new Error(`GET events.list ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as EventsListResponse;
    const remaining = limit - events.length;
    events.push(...(data.items ?? []).slice(0, remaining));
    pageToken = events.length < limit ? data.nextPageToken : undefined;
  } while (pageToken !== undefined);

  return {
    calendarId,
    window: { timeMin, timeMax },
    events: events.map((event) => ({
      id: event.id ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start: eventTime(event.start),
      end: eventTime(event.end),
      htmlLink: event.htmlLink ?? null,
      organizerEmail: event.organizer?.email ?? null,
      attendees: (event.attendees ?? []).map((attendee) => ({
        email: attendee.email ?? null,
        displayName: attendee.displayName ?? null,
        responseStatus: attendee.responseStatus ?? null,
      })),
      hangoutLink: event.hangoutLink ?? null,
    })),
  };
};
