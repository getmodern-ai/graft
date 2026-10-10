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
  etag?: string;
  htmlLink?: string;
  start?: unknown;
  end?: unknown;
  attendees?: Attendee[];
};

// A PATCH merges a boundary's fields into the event's, so the form not given is cleared with
// `null`: an all-day event moved to a time (or the reverse) would otherwise carry both forms, which
// Google refuses.
const eventDateTime = (value: string, timeZone: string | undefined) => {
  const result: { date?: string | null; dateTime?: string | null; timeZone?: string } =
    /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? { date: value, dateTime: null }
      : { dateTime: value, date: null };
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
  const eventPath = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;
  const patch: Record<string, unknown> = {};

  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.start !== undefined) patch.start = eventDateTime(input.start, input.timeZone);
  if (input.end !== undefined) patch.end = eventDateTime(input.end, input.timeZone);

  const query = new URLSearchParams({ sendUpdates: input.sendUpdates ?? "all" });
  // The guest list is read, merged and written back whole, so the write names the version it read
  // (`If-Match` on the event's etag): a guest added or a response changed in between makes Google
  // answer 412, and the merge is rebuilt from a fresh read rather than overwriting that change.
  for (let attempt = 1; ; attempt++) {
    let etag: string | undefined;
    if (attendeeChange) {
      const getResponse = await ctx.fetch(eventPath, { host: "www.googleapis.com" });
      if (!getResponse.ok) {
        throw new Error(`GET event ${getResponse.status}: ${await getResponse.text()}`);
      }
      const current = (await getResponse.json()) as EventResource;
      etag = current.etag;
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

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (etag !== undefined) headers["if-match"] = etag;
    const response = await ctx.fetch(`${eventPath}?${query.toString()}`, {
      method: "PATCH",
      host: "www.googleapis.com",
      headers,
      body: JSON.stringify(patch),
    });
    if (response.status === 412 && etag !== undefined && attempt < 3) continue;
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
  }
};
