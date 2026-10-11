export default async (input: Input, ctx: Context) => {
  const suppliedChannel = input.channel;
  const channelName = suppliedChannel.replace(/^#/, "").toLocaleLowerCase();
  let channelId: string | undefined;
  let cursor = "";

  do {
    const query = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) query.set("cursor", cursor);

    const path = `/conversations.list?${query.toString()}`;
    const res = await ctx.fetch(path);
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /conversations.list ${res.status}: ${text}`);

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Slack conversations.list returned invalid JSON: ${text}`);
    }

    if (!data || typeof data !== "object") {
      throw new Error("Slack conversations.list returned an invalid response");
    }

    const response = data as {
      ok?: boolean;
      error?: string;
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    };

    if (response.ok !== true) {
      throw new Error(`Slack conversations.list error: ${response.error ?? "unknown_error"}`);
    }

    for (const channel of response.channels ?? []) {
      if (
        channel.id === suppliedChannel ||
        (typeof channel.name === "string" && channel.name.toLocaleLowerCase() === channelName)
      ) {
        channelId = channel.id;
        break;
      }
    }

    cursor = response.response_metadata?.next_cursor ?? "";
  } while (!channelId && cursor);

  channelId ??= suppliedChannel;
  const emoji = input.emoji.replace(/^:+|:+$/g, "");
  if (!emoji) throw new Error("Emoji name cannot consist only of colons");

  const res = await ctx.fetch("/reactions.add", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      channel: channelId,
      timestamp: input.messageTs,
      name: emoji,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /reactions.add ${res.status}: ${text}`);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { channel: channelId, messageTs: input.messageTs, emoji, previewStatus: res.status };
  }

  if (!data || typeof data !== "object" || typeof (data as { ok?: unknown }).ok !== "boolean") {
    return { channel: channelId, messageTs: input.messageTs, emoji, previewStatus: res.status };
  }

  const response = data as { ok: boolean; error?: string };
  if (!response.ok) {
    if (response.error === "already_reacted") {
      return {
        channel: channelId,
        messageTs: input.messageTs,
        emoji,
        ok: true,
        alreadyReacted: true,
      };
    }
    throw new Error(`Slack reactions.add error: ${response.error ?? "unknown_error"}`);
  }

  return { channel: channelId, messageTs: input.messageTs, emoji, ok: true };
};
