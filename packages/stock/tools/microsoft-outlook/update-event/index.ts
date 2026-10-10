type EventInput = {
  eventId: string;
  subject?: string;
  body?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string;
  attendees?: Array<{
    address: string;
    name?: string;
    type?: "required" | "optional" | "resource";
  }>;
  isOnlineMeeting?: boolean;
};

export default async (input: Input, ctx: Context) => {
  const eventInput = input as EventInput;
  const body: Record<string, unknown> = {};

  if (eventInput.subject !== undefined) body.subject = eventInput.subject;
  if (eventInput.body !== undefined) {
    body.body = { contentType: "text", content: eventInput.body };
  }

  const timeZone = eventInput.timeZone ?? "UTC";
  if (eventInput.start !== undefined) {
    body.start = { dateTime: eventInput.start, timeZone };
  }
  if (eventInput.end !== undefined) {
    body.end = { dateTime: eventInput.end, timeZone };
  }

  if (eventInput.location !== undefined) {
    body.location = { displayName: eventInput.location };
  }
  if (eventInput.attendees !== undefined) {
    body.attendees = eventInput.attendees.map((attendee) => ({
      emailAddress: {
        address: attendee.address,
        ...(attendee.name !== undefined ? { name: attendee.name } : {}),
      },
      type: attendee.type ?? "required",
    }));
  }
  if (eventInput.isOnlineMeeting !== undefined) {
    body.isOnlineMeeting = eventInput.isOnlineMeeting;
  }

  const res = await ctx.fetch(`/me/events/${encodeURIComponent(eventInput.eventId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent: body };
  }
  if (!res.ok) {
    throw new Error(`PATCH /me/events/{id} ${res.status}: ${await res.text()}`);
  }

  const event = (await res.json()) as { id?: string; webLink?: string };
  return { updated: true, id: event.id ?? null, webLink: event.webLink ?? null };
};
