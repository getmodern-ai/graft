type SlackChannel = {
  id?: string;
  name?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
  num_members?: number;
};

type SlackResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackChannel[];
};

export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(
    "/conversations.list?types=public_channel&exclude_archived=true&limit=200",
    {
      method: "GET",
    },
  );

  if (!res.ok) {
    throw new Error(`GET /conversations.list ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as SlackResponse;
  if (!data.ok) {
    throw new Error(`Slack conversations.list failed: ${data.error ?? "unknown_error"}`);
  }

  return {
    channels: (data.channels ?? []).map((channel) => ({
      id: channel.id ?? null,
      name: channel.name ?? null,
      topic: channel.topic?.value ?? "",
      purpose: channel.purpose?.value ?? "",
      memberCount: channel.num_members ?? null,
    })),
  };
};
