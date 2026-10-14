type Attendee = {
  [key: string]: unknown;
  self?: boolean;
  responseStatus?: string;
  comment?: string;
};

type CalendarEvent = {
  id?: string;
  etag?: string;
  htmlLink?: string;
  attendees?: Attendee[];
};

export default async (input: Input, ctx: Context) => {
  const calendarId = input.calendarId ?? "primary";
  const sendUpdates = input.sendUpdates ?? "all";
  const eventPath = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;

  // The guest list is written back whole, so the write names the version it read (`If-Match` on
  // the event's etag): another guest's response landing in between makes Google answer 412, and
  // the list is read again rather than overwriting that response.
  for (let attempt = 1; ; attempt++) {
    const getResponse = await ctx.fetch(`${eventPath}?fields=id%2Cetag%2ChtmlLink%2Cattendees`, {
      host: "www.googleapis.com",
    });
    if (!getResponse.ok) {
      throw new Error(`GET event ${getResponse.status}: ${await getResponse.text()}`);
    }

    const event = (await getResponse.json()) as CalendarEvent;
    const attendees = event.attendees;
    if (!Array.isArray(attendees) || !attendees.some((attendee) => attendee.self === true)) {
      throw new Error("The calendar's owner is not invited to that event.");
    }

    const updatedAttendees = attendees.map((attendee) => {
      if (attendee.self !== true) return attendee;
      const updated: Attendee = { ...attendee, responseStatus: input.response };
      if (input.comment !== undefined) updated.comment = input.comment;
      return updated;
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (event.etag !== undefined) headers["if-match"] = event.etag;
    const patchResponse = await ctx.fetch(
      `${eventPath}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      {
        method: "PATCH",
        host: "www.googleapis.com",
        headers,
        body: JSON.stringify({ attendees: updatedAttendees }),
      },
    );
    if (patchResponse.status === 412 && event.etag !== undefined && attempt < 3) continue;
    if (!patchResponse.ok) {
      throw new Error(`PATCH event ${patchResponse.status}: ${await patchResponse.text()}`);
    }

    const patched = (await patchResponse.json()) as CalendarEvent;
    return {
      eventId: patched.id ?? event.id ?? input.eventId,
      response: input.response,
      htmlLink: patched.htmlLink ?? event.htmlLink ?? null,
    };
  }
};
