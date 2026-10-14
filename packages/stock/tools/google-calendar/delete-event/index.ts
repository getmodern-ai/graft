export default async (input: Input, ctx: Context) => {
  const calendarId = input.calendarId ?? "primary";
  const sendUpdates = input.sendUpdates ?? "all";
  const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`;
  const res = await ctx.fetch(path, { method: "DELETE", host: "www.googleapis.com" });
  if (!res.ok) {
    throw new Error(`DELETE event ${res.status}: ${await res.text()}`);
  }
  return { deleted: true, eventId: input.eventId, calendarId };
};
