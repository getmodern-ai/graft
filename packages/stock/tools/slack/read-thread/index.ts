type SlackReaction = {
  name?: string;
};

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  reactions?: SlackReaction[];
};

type SlackChannel = {
  id?: string;
  name?: string;
};

type SlackListResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackRepliesResponse = {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
};

async function slackJson<T>(res: Response, operation: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${operation} HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export default async (input: Input, ctx: Context) => {
  const requestedChannel = input.channel;
  const normalizedName = requestedChannel.startsWith("#")
    ? requestedChannel.slice(1).toLowerCase()
    : requestedChannel.toLowerCase();

  let channelId: string | undefined;
  let cursor = "";

  do {
    const query = new URLSearchParams();
    query.set("types", "public_channel,private_channel");
    query.set("exclude_archived", "true");
    query.set("limit", "200");
    if (cursor) query.set("cursor", cursor);

    const res = await ctx.fetch(`/conversations.list?${query.toString()}`);
    const page = await slackJson<SlackListResponse>(res, "Slack conversations.list");
    if (!page.ok) {
      throw new Error(`Slack conversations.list error: ${page.error ?? "unknown_error"}`);
    }

    for (const channel of page.channels ?? []) {
      if (
        channel.id === requestedChannel ||
        (typeof channel.name === "string" && channel.name.toLowerCase() === normalizedName)
      ) {
        channelId = channel.id;
        break;
      }
    }

    cursor = page.response_metadata?.next_cursor ?? "";
  } while (!channelId && cursor);

  channelId ??= requestedChannel;

  const repliesQuery = new URLSearchParams();
  repliesQuery.set("channel", channelId);
  repliesQuery.set("ts", input.threadTs);
  repliesQuery.set("limit", String(input.limit ?? 50));

  const repliesRes = await ctx.fetch(`/conversations.replies?${repliesQuery.toString()}`);
  const replies = await slackJson<SlackRepliesResponse>(repliesRes, "Slack conversations.replies");
  if (!replies.ok) {
    throw new Error(`Slack conversations.replies error: ${replies.error ?? "unknown_error"}`);
  }

  const messages = (replies.messages ?? [])
    .map((message) => ({
      ts: message.ts ?? "",
      user: message.user ?? null,
      text: message.text ?? "",
      reactions: (message.reactions ?? [])
        .map((reaction) => reaction.name)
        .filter((name): name is string => typeof name === "string"),
    }))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  return { channel: channelId, messages };
};
