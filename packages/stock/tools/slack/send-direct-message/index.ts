type SlackObject = Record<string, unknown>;

function asObject(value: unknown): SlackObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SlackObject)
    : null;
}

function slackError(data: SlackObject): string {
  return typeof data.error === "string" ? data.error : "unknown_error";
}

function memberLabel(member: SlackObject): string {
  const profile = asObject(member.profile);
  const realName =
    typeof member.real_name === "string" && member.real_name.length > 0
      ? member.real_name
      : typeof profile?.real_name === "string" && profile.real_name.length > 0
        ? profile.real_name
        : "unknown real name";
  const id = typeof member.id === "string" ? member.id : "unknown id";
  return `${id} (${realName})`;
}

function matchesName(member: SlackObject, wanted: string): boolean {
  const profile = asObject(member.profile);
  const candidates = [member.name, member.real_name, profile?.real_name, profile?.display_name];
  return candidates.some(
    (candidate) => typeof candidate === "string" && candidate.toLocaleLowerCase() === wanted,
  );
}

async function readSlack(ctx: Context, path: string): Promise<SlackObject> {
  const res = await ctx.fetch(path);
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
  const data = asObject(await res.json());
  if (!data) throw new Error(`GET ${path} returned an invalid Slack response`);
  if (data.ok !== true) throw new Error(`Slack error from GET ${path}: ${slackError(data)}`);
  return data;
}

async function resolveUser(input: Input, ctx: Context): Promise<string> {
  if (input.user.includes("@")) {
    const query = new URLSearchParams({ email: input.user });
    const data = await readSlack(ctx, `/users.lookupByEmail?${query.toString()}`);
    const user = asObject(data.user);
    if (!user || typeof user.id !== "string") {
      throw new Error("Slack users.lookupByEmail returned no user id");
    }
    return user.id;
  }

  const wantedName = input.user.toLocaleLowerCase();
  const nameMatches: SlackObject[] = [];
  let cursor = "";

  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const path = `/users.list?${query.toString()}`;
    const data = await readSlack(ctx, path);
    const members = Array.isArray(data.members) ? data.members : [];

    for (const value of members) {
      const member = asObject(value);
      if (!member || member.deleted === true) continue;
      if (member.id === input.user) return input.user;
      if (matchesName(member, wantedName)) nameMatches.push(member);
    }

    const metadata = asObject(data.response_metadata);
    cursor = typeof metadata?.next_cursor === "string" ? metadata.next_cursor : "";
  } while (cursor);

  if (nameMatches.length === 0) {
    throw new Error(
      `No Slack user matched ${JSON.stringify(input.user)}; find-user searches by part of a name.`,
    );
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Several Slack users matched ${JSON.stringify(input.user)}: ${nameMatches.map(memberLabel).join(", ")}. Pass one Slack user id.`,
    );
  }

  const id = nameMatches[0]?.id;
  if (typeof id !== "string") throw new Error("The matching Slack user had no id");
  return id;
}

export default async (input: Input, ctx: Context) => {
  const userId = await resolveUser(input, ctx);
  const res = await ctx.fetch("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: userId, text: input.text }),
  });

  if (!res.ok) throw new Error(`POST /chat.postMessage ${res.status}: ${await res.text()}`);
  const data = asObject(await res.json());

  if (!data || typeof data.ok !== "boolean") {
    return { userId, previewStatus: res.status };
  }
  if (!data.ok) throw new Error(`Slack error from chat.postMessage: ${slackError(data)}`);
  if (typeof data.channel !== "string" || typeof data.ts !== "string") {
    throw new Error("Slack chat.postMessage returned no channel or timestamp");
  }

  return { userId, channel: data.channel, ts: data.ts, ok: true };
};
