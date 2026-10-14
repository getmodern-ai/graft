export default async (input: Input, ctx: Context) => {
  const eventId = input.eventId;
  const res = await ctx.fetch(`/me/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { deleted: false, eventId };
  }

  if (res.status === 204) {
    return { deleted: true, eventId };
  }

  throw new Error(`DELETE /me/events/{eventId} ${res.status}: ${await res.text()}`);
};
