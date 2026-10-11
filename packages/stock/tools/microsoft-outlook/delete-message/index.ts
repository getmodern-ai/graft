export default async (input: Input, ctx: Context) => {
  const path = `/me/messages/${encodeURIComponent(input.messageId)}`;
  const res = await ctx.fetch(path, { method: "DELETE" });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { deleted: false, messageId: input.messageId };
  }

  if (res.status === 204) {
    return { deleted: true, messageId: input.messageId };
  }

  throw new Error(`DELETE ${path} ${res.status}: ${await res.text()}`);
};
