type ApolloPerson = {
  id?: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  organization?: { name?: string } | null;
  has_email?: boolean;
};

type ApolloSearchResponse = {
  total_entries?: number;
  pagination?: { total_entries?: number };
  people?: ApolloPerson[];
};

export default async (input: Input, ctx: Context) => {
  const body: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: input.perPage ?? 5,
  };

  if (input.titles !== undefined) body.person_titles = input.titles;
  if (input.locations !== undefined) body.person_locations = input.locations;
  if (input.organizationDomains !== undefined) {
    body.q_organization_domains_list = input.organizationDomains;
  }
  if (input.seniorities !== undefined) body.person_seniorities = input.seniorities;
  if (input.keywords !== undefined) body.q_keywords = input.keywords;

  const res = await ctx.fetch("/api/v1/mixed_people/api_search", {
    host: "api.apollo.io",
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /api/v1/mixed_people/api_search ${res.status}: ${await res.text()}`);
  }

  const result = (await res.json()) as ApolloSearchResponse;
  return {
    total_entries: result.total_entries ?? result.pagination?.total_entries ?? 0,
    people: (result.people ?? []).map((person) => ({
      id: person.id ?? null,
      first_name: person.first_name ?? null,
      last_name_obfuscated: person.last_name_obfuscated ?? null,
      title: person.title ?? null,
      organization_name: person.organization?.name ?? null,
      has_email: person.has_email ?? false,
    })),
  };
};
