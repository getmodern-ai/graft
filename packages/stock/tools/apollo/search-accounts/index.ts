type ApolloAccount = {
  id?: string | null;
  name?: string | null;
  domain?: string | null;
  owner_id?: string | null;
  account_stage_id?: string | null;
};

type ApolloSearchResponse = {
  accounts?: ApolloAccount[];
  pagination?: {
    total_entries?: number;
  };
};

export default async (input: Input, ctx: Context) => {
  const body: Record<string, string | number | boolean> = {
    page: input.page ?? 1,
    per_page: input.perPage ?? 10,
  };

  if (input.name !== undefined) body.q_organization_name = input.name;
  if (input.sortBy !== undefined) body.sort_by_field = input.sortBy;
  if (input.sortAscending !== undefined) body.sort_ascending = input.sortAscending;

  const res = await ctx.fetch("/api/v1/accounts/search", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /api/v1/accounts/search ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApolloSearchResponse;
  return {
    total_entries: data.pagination?.total_entries ?? 0,
    accounts: (data.accounts ?? []).map((account) => ({
      id: account.id ?? null,
      name: account.name ?? null,
      domain: account.domain ?? null,
      owner_id: account.owner_id ?? null,
      account_stage_id: account.account_stage_id ?? null,
    })),
  };
};
