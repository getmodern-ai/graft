type Attendee = {
  [key: string]: unknown;
  self?: boolean;
  responseStatus?: string;
  comment?: string;
};

type CalendarEvent = {
  id?: string;
  htmlLink?: string;
  attendees?: Attendee[];
};

export default async (input: Input, ctx: Context) => {
  const calendarId = input.calendarId ?? "primary";
  const sendUpdates = input.sendUpdates ?? "all";
  const eventPath = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;

  const getResponse = await ctx.fetch(`${eventPath}?fields=id%2ChtmlLink%2Cattendees`);
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

  const patchResponse = await ctx.fetch(
    `${eventPath}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attendees: updatedAttendees }),
    },
  );
  if (!patchResponse.ok) {
    throw new Error(`PATCH event ${patchResponse.status}: ${await patchResponse.text()}`);
  }

  const patched = (await patchResponse.json()) as CalendarEvent;
  return {
    eventId: patched.id ?? event.id ?? input.eventId,
    response: input.response,
    htmlLink: patched.htmlLink ?? event.htmlLink ?? null,
  };
};
