type SlackProfile = {
  real_name?: string | null;
  display_name?: string | null;
  email?: string | null;
  title?: string | null;
};

type SlackUser = {
  id?: string | null;
  name?: string | null;
  real_name?: string | null;
  deleted?: boolean;
  tz?: string | null;
  profile?: SlackProfile | null;
  is_bot?: boolean;
};

type SlackResponse = {
  ok?: boolean;
  error?: string;
  user?: SlackUser;
  members?: SlackUser[];
  response_metadata?: { next_cursor?: string | null };
};

function match(user: SlackUser) {
  return {
    id: user.id ?? null,
    name: user.name ?? null,
    realName: user.real_name ?? user.profile?.real_name ?? null,
    displayName: user.profile?.display_name ?? null,
    email: user.profile?.email ?? null,
    title: user.profile?.title ?? null,
    timezone: user.tz ?? null,
    isBot: user.is_bot ?? false,
  };
}

async function getSlack(path: string, ctx: Context): Promise<SlackResponse> {
  const res = await ctx.fetch(path);
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as SlackResponse;
  if (!data.ok) throw new Error(`Slack error: ${data.error ?? "unknown_error"}`);
  return data;
}

export default async (input: Input, ctx: Context) => {
  const query = input.query.trim();
  if (!query) throw new Error("query must contain a name or email address");

  // A user id, as a message's `user` carries it: Slack's ids are U or W and then upper-case
  // letters and digits, which no name search would find.
  if (/^[UW][A-Z0-9]{6,}$/.test(query)) {
    const res = await ctx.fetch(`/users.info?user=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`GET /users.info ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as SlackResponse;
    if (!data.ok) {
      if (data.error === "user_not_found") return { matches: [] };
      throw new Error(`Slack error: ${data.error ?? "unknown_error"}`);
    }
    return { matches: data.user ? [match(data.user)] : [] };
  }

  if (query.includes("@")) {
    const path = `/users.lookupByEmail?email=${encodeURIComponent(query)}`;
    const res = await ctx.fetch(path);
    if (!res.ok) throw new Error(`GET /users.lookupByEmail ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as SlackResponse;
    if (!data.ok) {
      if (data.error === "users_not_found") return { matches: [] };
      throw new Error(`Slack error: ${data.error ?? "unknown_error"}`);
    }
    return { matches: data.user && !data.user.deleted ? [match(data.user)] : [] };
  }

  const needle = query.toLocaleLowerCase();
  const found: Array<{ user: SlackUser; exact: boolean }> = [];
  let cursor = "";

  do {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const data = await getSlack(`/users.list?${params.toString()}`, ctx);

    for (const user of data.members ?? []) {
      if (user.deleted) continue;
      const values = [
        user.name,
        user.real_name,
        user.profile?.real_name,
        user.profile?.display_name,
      ].filter((value): value is string => typeof value === "string");
      const normalized = values.map((value) => value.toLocaleLowerCase());
      if (normalized.some((value) => value.includes(needle))) {
        found.push({ user, exact: normalized.some((value) => value === needle) });
      }
    }

    cursor = data.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);

  found.sort((a, b) => Number(b.exact) - Number(a.exact));
  return { matches: found.slice(0, 10).map(({ user }) => match(user)) };
};
