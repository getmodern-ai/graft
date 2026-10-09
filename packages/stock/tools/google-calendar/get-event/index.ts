type EventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type EventPerson = {
  email?: string;
};

type EventAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
};

type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  htmlLink?: string;
  hangoutLink?: string;
  organizer?: EventPerson;
  creator?: EventPerson;
  attendees?: EventAttendee[];
  visibility?: string;
};

function eventTime(value?: EventDateTime) {
  if (!value) return null;
  return {
    dateTime: value.dateTime ?? null,
    date: value.date ?? null,
    timeZone: value.timeZone ?? null,
  };
}

export default async (input: Input, ctx: Context) => {
  const calendarId = input.calendarId ?? "primary";
  const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  const res = await ctx.fetch(path);
  if (!res.ok) throw new Error(`GET event ${res.status}: ${await res.text()}`);

  const event = (await res.json()) as CalendarEvent;
  return {
    id: event.id ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: eventTime(event.start),
    end: eventTime(event.end),
    recurrence: event.recurrence ?? [],
    recurringEventId: event.recurringEventId ?? null,
    htmlLink: event.htmlLink ?? null,
    hangoutLink: event.hangoutLink ?? null,
    organizerEmail: event.organizer?.email ?? null,
    creatorEmail: event.creator?.email ?? null,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email ?? null,
      displayName: attendee.displayName ?? null,
      responseStatus: attendee.responseStatus ?? null,
      optional: attendee.optional ?? null,
      organizer: attendee.organizer ?? null,
      self: attendee.self ?? null,
    })),
    visibility: event.visibility ?? null,
  };
};
