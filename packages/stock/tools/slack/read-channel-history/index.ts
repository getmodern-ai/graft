type SlackChannel = {
  id?: string;
  name?: string;
  is_general?: boolean;
};

type SlackReaction = {
  name?: string;
};

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
};

type SlackListResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
};

type SlackHistoryResponse = {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
};

async function readSlackJson<T>(res: Response, operation: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${operation} HTTP ${res.status}: ${text}`);

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`${operation} returned invalid JSON: ${text}`);
  }

  const envelope = data as { ok?: boolean; error?: string };
  if (envelope.ok !== true) {
    throw new Error(`${operation} Slack error: ${envelope.error ?? "unknown_error"}`);
  }
  return data;
}

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 20;
  const supplied = input.channel?.trim();
  const looksLikeId = supplied !== undefined && /^[CGD][A-Z0-9]+$/.test(supplied);

  let channelId: string;
  let channelName: string | null = null;

  if (looksLikeId) {
    channelId = supplied;
  } else {
    const wantedName = supplied?.replace(/^#/, "").toLocaleLowerCase();
    let cursor = "";
    let selected: SlackChannel | undefined;

    do {
      const params = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await ctx.fetch(`/conversations.list?${params.toString()}`);
      const data = await readSlackJson<SlackListResponse>(res, "conversations.list");
      const channels = data.channels ?? [];

      selected = wantedName
        ? channels.find((channel) => channel.name?.toLocaleLowerCase() === wantedName)
        : channels.find((channel) => channel.is_general === true);

      cursor = data.response_metadata?.next_cursor?.trim() ?? "";
    } while (!selected && cursor);

    if (!selected?.id) {
      if (wantedName) {
        throw new Error(
          `No Slack channel matched ${supplied}; list-channels lists available channels.`,
        );
      }
      throw new Error(
        "No Slack general channel was found; list-channels lists available channels.",
      );
    }

    channelId = selected.id;
    channelName = selected.name ?? null;
  }

  const historyParams = new URLSearchParams({ channel: channelId, limit: String(limit) });
  const historyRes = await ctx.fetch(`/conversations.history?${historyParams.toString()}`);
  const history = await readSlackJson<SlackHistoryResponse>(historyRes, "conversations.history");

  return {
    channel: {
      id: channelId,
      name: channelName,
    },
    messages: (history.messages ?? []).map((message) => ({
      ts: message.ts ?? null,
      user: message.user ?? null,
      text: message.text ?? null,
      thread_ts: message.thread_ts ?? null,
      reply_count: message.reply_count ?? null,
      reactions: (message.reactions ?? [])
        .map((reaction) => reaction.name)
        .filter((name): name is string => typeof name === "string"),
    })),
  };
};
