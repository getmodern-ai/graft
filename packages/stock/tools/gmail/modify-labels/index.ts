export default async (input: Input, ctx: Context) => {
  const hasThread = typeof input.threadId === "string" && input.threadId.length > 0;
  const hasMessage = typeof input.messageId === "string" && input.messageId.length > 0;
  if (hasThread === hasMessage) {
    throw new Error("Provide exactly one of threadId or messageId.");
  }

  const add = new Set<string>(input.addLabelIds ?? []);
  const remove = new Set<string>(input.removeLabelIds ?? []);

  if (input.archive) remove.add("INBOX");
  if (input.markRead) remove.add("UNREAD");
  if (input.markUnread) add.add("UNREAD");
  if (input.star) add.add("STARRED");
  if (input.unstar) remove.add("STARRED");

  const addedLabelIds = [...add];
  const removedLabelIds = [...remove];

  if (addedLabelIds.length === 0 && removedLabelIds.length === 0) {
    throw new Error("Provide at least one label to add or remove, or enable a shortcut.");
  }
  if (addedLabelIds.length > 100 || removedLabelIds.length > 100) {
    throw new Error(
      "Gmail allows at most 100 labels to be added and 100 labels to be removed per update.",
    );
  }

  const conflicts = addedLabelIds.filter((labelId) => remove.has(labelId));
  if (conflicts.length > 0) {
    throw new Error(`A label cannot be both added and removed: ${conflicts.join(", ")}`);
  }

  const target = hasThread ? "thread" : "message";
  const id = (hasThread ? input.threadId : input.messageId) ?? "";
  const path =
    target === "thread"
      ? `/users/me/threads/${encodeURIComponent(id)}/modify`
      : `/users/me/messages/${encodeURIComponent(id)}/modify`;

  const res = await ctx.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds: addedLabelIds, removeLabelIds: removedLabelIds }),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  return { target, id, addedLabelIds, removedLabelIds };
};
