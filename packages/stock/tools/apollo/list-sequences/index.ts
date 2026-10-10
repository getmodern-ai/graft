type Sequence = {
  id?: unknown;
  name?: unknown;
  active?: unknown;
  archived?: unknown;
  num_steps?: unknown;
  created_at?: unknown;
};

type SearchResponse = {
  emailer_campaigns?: unknown;
  pagination?: { total_entries?: unknown };
};

export default async (input: Input, ctx: Context) => {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? 10;
  const body: { q_name?: string; page: number; per_page: number } = {
    page,
    per_page: perPage,
  };

  if (input.name) body.q_name = input.name;

  const res = await ctx.fetch("/api/v1/emailer_campaigns/search", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /api/v1/emailer_campaigns/search ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as SearchResponse;
  const campaigns = Array.isArray(data.emailer_campaigns)
    ? (data.emailer_campaigns as Sequence[])
    : [];

  return {
    total_entries: data.pagination?.total_entries ?? 0,
    emailer_campaigns: campaigns.map((sequence) => ({
      id: sequence.id ?? null,
      name: sequence.name ?? null,
      active: sequence.active ?? null,
      archived: sequence.archived ?? null,
      num_steps: sequence.num_steps ?? null,
      created_at: sequence.created_at ?? null,
    })),
  };
};
