export default async (input: Input, ctx: Context) => {
  const action = input.replyAll === true ? "replyAll" : "reply";
  const path = `/me/messages/${encodeURIComponent(input.messageId)}/${action}`;
  const requestBody = { comment: input.comment };

  const res = await ctx.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (res.status !== 202) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  if (res.headers.get("x-graft-dry-run") === "intercepted") {
    return { sent: false, preview: requestBody };
  }

  return { sent: true };
};
