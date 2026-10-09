type Attendee = {
  email?: string;
  displayName?: string;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: string;
  comment?: string;
  additionalGuests?: number;
  [key: string]: unknown;
};

type EventResource = {
  id?: string;
  htmlLink?: string;
  start?: unknown;
  end?: unknown;
  attendees?: Attendee[];
};

const eventDateTime = (value: string, timeZone: string | undefined) => {
  const result: { date?: string; dateTime?: string; timeZone?: string } =
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
  if (timeZone !== undefined) result.timeZone = timeZone;
  return result;
};

export default async (input: Input, ctx: Context) => {
  const attendeeChange = input.addAttendees !== undefined || input.removeAttendees !== undefined;
  const hasChange =
    input.summary !== undefined ||
    input.description !== undefined ||
    input.location !== undefined ||
    input.start !== undefined ||
    input.end !== undefined ||
    attendeeChange;

  if (!hasChange) {
    throw new Error(
      "Provide at least one event change: summary, description, location, start, end, addAttendees, or removeAttendees.",
    );
  }

  const calendarId = input.calendarId ?? "primary";
  const eventPath = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  const patch: Record<string, unknown> = {};

  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.start !== undefined) patch.start = eventDateTime(input.start, input.timeZone);
  if (input.end !== undefined) patch.end = eventDateTime(input.end, input.timeZone);

  if (attendeeChange) {
    const getResponse = await ctx.fetch(eventPath);
    if (!getResponse.ok) {
      throw new Error(`GET event ${getResponse.status}: ${await getResponse.text()}`);
    }
    const current = (await getResponse.json()) as EventResource;
    const removed = new Set((input.removeAttendees ?? []).map((email) => email.toLowerCase()));
    const merged = (current.attendees ?? []).filter(
      (attendee) => attendee.email === undefined || !removed.has(attendee.email.toLowerCase()),
    );
    const present = new Set(
      merged.flatMap((attendee) =>
        attendee.email === undefined ? [] : [attendee.email.toLowerCase()],
      ),
    );
    for (const email of input.addAttendees ?? []) {
      const normalized = email.toLowerCase();
      if (!present.has(normalized)) {
        merged.push({ email });
        present.add(normalized);
      }
    }
    patch.attendees = merged;
  }

  const query = new URLSearchParams({ sendUpdates: input.sendUpdates ?? "all" });
  const response = await ctx.fetch(`${eventPath}?${query.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`PATCH event ${response.status}: ${await response.text()}`);
  }

  const updated = (await response.json()) as EventResource;
  return {
    id: updated.id ?? null,
    htmlLink: updated.htmlLink ?? null,
    start: updated.start ?? null,
    end: updated.end ?? null,
    attendeeEmails: (updated.attendees ?? []).flatMap((attendee) =>
      attendee.email === undefined ? [] : [attendee.email],
    ),
  };
};
