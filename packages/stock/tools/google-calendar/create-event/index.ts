export default async (input: Input, ctx: Context) => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const startIsDate = dateOnly.test(input.start);
  const endIsDate = dateOnly.test(input.end);
  if (startIsDate !== endIsDate) {
    throw new Error("start and end must both be date-times or both be YYYY-MM-DD dates");
  }

  const start: Record<string, string> = startIsDate
    ? { date: input.start }
    : { dateTime: input.start };
  const end: Record<string, string> = endIsDate ? { date: input.end } : { dateTime: input.end };

  if (input.timeZone) {
    start.timeZone = input.timeZone;
    end.timeZone = input.timeZone;
  }

  const body: Record<string, unknown> = {
    summary: input.summary,
    start,
    end,
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  if (input.addMeetLink === true) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const query = new URLSearchParams({
    sendUpdates: input.sendUpdates ?? "all",
  });
  if (input.addMeetLink === true) query.set("conferenceDataVersion", "1");

  const calendarId = encodeURIComponent(input.calendarId ?? "primary");
  const res = await ctx.fetch(`/calendar/v3/calendars/${calendarId}/events?${query.toString()}`, {
    method: "POST",
    host: "www.googleapis.com",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST /calendars/{calendarId}/events ${res.status}: ${await res.text()}`);
  }

  const event = (await res.json()) as Record<string, unknown>;
  return {
    id: event.id ?? null,
    htmlLink: event.htmlLink ?? null,
    status: event.status ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    hangoutLink: event.hangoutLink ?? null,
  };
};
