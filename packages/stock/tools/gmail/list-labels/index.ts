type GmailLabel = {
  id?: string;
  name?: string;
  type?: string;
};

type GmailLabelsResponse = {
  labels?: GmailLabel[];
};

export default async (input: Input, ctx: Context) => {
  void input;
  const res = await ctx.fetch("/users/me/labels");
  if (!res.ok) {
    throw new Error(`GET /users/me/labels ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as GmailLabelsResponse;
  const labels = (data.labels ?? [])
    .filter(
      (label): label is { id: string; name: string; type: "system" | "user" } =>
        typeof label.id === "string" &&
        typeof label.name === "string" &&
        (label.type === "system" || label.type === "user"),
    )
    .map(({ id, name, type }) => ({ id, name, type }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "system" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { labels };
};
