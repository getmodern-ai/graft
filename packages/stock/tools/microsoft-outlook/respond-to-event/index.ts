export default async (input: Input, ctx: Context) => {
  const action =
    input.response === "accept"
      ? "accept"
      : input.response === "decline"
        ? "decline"
        : "tentativelyAccept";

  const body = {
    comment: input.comment ?? "",
    sendResponse: input.sendResponse ?? true,
  };

  const res = await ctx.fetch(`/me/events/${encodeURIComponent(input.eventId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status !== 202) {
    throw new Error(`POST /me/events/{eventId}/${action} ${res.status}: ${await res.text()}`);
  }

  if (res.headers.get("x-graft-dry-run") === "intercepted") {
    return { responded: false, sent: body, response: input.response };
  }

  return { responded: true, response: input.response };
};
