type EventBody = {
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isOnlineMeeting: boolean;
  body?: { contentType: "text"; content: string };
  location?: { displayName: string };
  attendees?: Array<{
    emailAddress: { address: string };
    type: "required";
  }>;
  isAllDay?: boolean;
};

export default async (input: Input, ctx: Context) => {
  const startTime = Date.parse(`${input.start}Z`);
  const endTime = Date.parse(`${input.end}Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Start and end must be valid ISO 8601 local date-times.");
  }
  if (endTime <= startTime) {
    throw new Error("Event end must be after event start.");
  }

  const timeZone = input.timeZone ?? "UTC";
  const body: EventBody = {
    subject: input.subject,
    start: { dateTime: input.start, timeZone },
    end: { dateTime: input.end, timeZone },
    isOnlineMeeting: input.isOnlineMeeting ?? false,
  };

  if (input.body !== undefined) {
    body.body = { contentType: "text", content: input.body };
  }
  if (input.location !== undefined) {
    body.location = { displayName: input.location };
  }
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((address) => ({
      emailAddress: { address },
      type: "required",
    }));
  }
  if (input.isAllDay !== undefined) {
    body.isAllDay = input.isAllDay;
  }

  const path = input.calendarId
    ? `/me/calendars/${encodeURIComponent(input.calendarId)}/events`
    : "/me/events";
  const res = await ctx.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: body };
  }
  if (res.status !== 201) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const event = (await res.json()) as { id?: unknown; webLink?: unknown };
  return {
    created: true,
    id: typeof event.id === "string" ? event.id : null,
    webLink: typeof event.webLink === "string" ? event.webLink : null,
  };
};
