type Conversation = {
  id?: string;
  name?: string;
};

type ConversationsListResponse = {
  ok?: boolean;
  error?: string;
  channels?: Conversation[];
  response_metadata?: {
    next_cursor?: string;
  };
};

type PostMessageResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
};

export default async (input: Input, ctx: Context) => {
  const suppliedChannel = input.channel;
  const normalizedName = suppliedChannel.startsWith("#")
    ? suppliedChannel.slice(1).toLowerCase()
    : suppliedChannel.toLowerCase();

  let channelId = suppliedChannel;
  let cursor = "";
  let matched = false;

  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await ctx.fetch(`/conversations.list?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`GET /conversations.list ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as ConversationsListResponse;
    if (data.ok !== true) {
      throw new Error(`Slack conversations.list error: ${data.error ?? "unknown_error"}`);
    }

    for (const channel of data.channels ?? []) {
      if (
        channel.id === suppliedChannel ||
        (typeof channel.name === "string" && channel.name.toLowerCase() === normalizedName)
      ) {
        channelId = channel.id ?? suppliedChannel;
        matched = true;
        break;
      }
    }

    cursor = data.response_metadata?.next_cursor ?? "";
  } while (!matched && cursor);

  const post = await ctx.fetch("/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: channelId,
      thread_ts: input.threadTs,
      text: input.text,
      reply_broadcast: input.alsoSendToChannel ?? false,
    }),
  });

  const responseText = await post.text();
  let data: PostMessageResponse | null = null;
  try {
    data = JSON.parse(responseText) as PostMessageResponse;
  } catch {
    data = null;
  }

  if (data && typeof data.ok === "boolean") {
    if (!data.ok) {
      throw new Error(`Slack chat.postMessage error: ${data.error ?? "unknown_error"}`);
    }
    if (typeof data.ts !== "string") {
      throw new Error("Slack chat.postMessage error: missing reply ts");
    }
    return {
      channel: channelId,
      threadTs: input.threadTs,
      ts: data.ts,
      ok: true,
    };
  }

  // No Slack answer: the dry run's preview (a 2xx) or the proxy's own refusal (a 4xx or 5xx with
  // no `ok`), which is a failure, not a reply sent.
  if (!post.ok) throw new Error(`POST /chat.postMessage ${post.status}: ${responseText}`);
  return {
    channel: channelId,
    threadTs: input.threadTs,
    previewStatus: post.status,
  };
};
