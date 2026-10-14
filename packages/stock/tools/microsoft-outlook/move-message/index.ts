export default async (input: Input, ctx: Context) => {
  const body = { destinationId: input.destinationId ?? "archive" };
  const path = `/me/messages/${encodeURIComponent(input.messageId)}/move`;
  const res = await ctx.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { moved: false, sent: body };
  }

  if (res.status !== 201) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const message = (await res.json()) as { id?: unknown; parentFolderId?: unknown };
  if (typeof message.id !== "string" || typeof message.parentFolderId !== "string") {
    throw new Error(`POST ${path} 201: response did not include id and parentFolderId`);
  }

  return { moved: true, id: message.id, parentFolderId: message.parentFolderId };
};
