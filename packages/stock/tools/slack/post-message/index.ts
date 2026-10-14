type SlackChannel = {
  id?: unknown;
  name?: unknown;
};

type SlackListResponse = {
  ok?: unknown;
  error?: unknown;
  channels?: unknown;
  response_metadata?: unknown;
};

type SlackPostResponse = {
  ok?: unknown;
  error?: unknown;
  channel?: unknown;
  ts?: unknown;
};

function errorName(value: unknown): string {
  return typeof value === "string" ? value : "unknown_error";
}

export default async (input: Input, ctx: Context) => {
  const requestedName = input.channel.startsWith("#") ? input.channel.slice(1) : input.channel;
  const requestedNameLower = requestedName.toLowerCase();
  let cursor = "";
  let channelId: string | null = null;

  do {
    const query = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) query.set("cursor", cursor);

    const path = `/conversations.list?${query.toString()}`;
    const res = await ctx.fetch(path);
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`GET /conversations.list ${res.status}: ${bodyText}`);

    let data: SlackListResponse;
    try {
      data = JSON.parse(bodyText) as SlackListResponse;
    } catch {
      throw new Error(`GET /conversations.list ${res.status}: invalid JSON response`);
    }

    if (data.ok !== true) {
      throw new Error(`Slack conversations.list error: ${errorName(data.error)}`);
    }

    const channels = Array.isArray(data.channels) ? (data.channels as SlackChannel[]) : [];
    for (const channel of channels) {
      const id = typeof channel.id === "string" ? channel.id : null;
      const name = typeof channel.name === "string" ? channel.name : null;
      if (id === input.channel || (id && name?.toLowerCase() === requestedNameLower)) {
        channelId = id;
        break;
      }
    }

    if (channelId) break;
    const metadata = data.response_metadata;
    cursor =
      metadata &&
      typeof metadata === "object" &&
      "next_cursor" in metadata &&
      typeof metadata.next_cursor === "string"
        ? metadata.next_cursor
        : "";
  } while (cursor);

  const resolvedChannel = channelId ?? input.channel;
  const postRes = await ctx.fetch("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: resolvedChannel, text: input.text }),
  });
  const postText = await postRes.text();

  let postData: SlackPostResponse | null = null;
  try {
    const parsed = JSON.parse(postText) as unknown;
    if (parsed && typeof parsed === "object") postData = parsed as SlackPostResponse;
  } catch {
    postData = null;
  }

  if (postData && typeof postData.ok === "boolean") {
    if (postData.ok !== true) {
      throw new Error(`Slack chat.postMessage error: ${errorName(postData.error)}`);
    }
    return {
      channel: typeof postData.channel === "string" ? postData.channel : resolvedChannel,
      ts: typeof postData.ts === "string" ? postData.ts : null,
      ok: true,
    };
  }

  if (!postRes.ok) throw new Error(`POST /chat.postMessage ${postRes.status}: ${postText}`);
  return { channel: resolvedChannel, previewStatus: postRes.status };
};
