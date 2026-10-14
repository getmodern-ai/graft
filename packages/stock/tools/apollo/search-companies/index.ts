type ApolloOrganization = {
  id?: string | null;
  name?: string | null;
  website_url?: string | null;
  primary_domain?: string | null;
  linkedin_url?: string | null;
  estimated_num_employees?: number | null;
  city?: string | null;
  country?: string | null;
};

type ApolloSearchResponse = {
  pagination?: { total_entries?: number | null };
  organizations?: ApolloOrganization[];
};

export default async (input: Input, ctx: Context) => {
  const body: Record<string, string | string[] | number> = {
    page: input.page ?? 1,
    per_page: input.perPage ?? 5,
  };

  if (input.name !== undefined) body.q_organization_name = input.name;
  if (input.domains !== undefined) body.q_organization_domains_list = input.domains;
  if (input.locations !== undefined) body.organization_locations = input.locations;
  if (input.employeeRanges !== undefined) {
    body.organization_num_employees_ranges = input.employeeRanges;
  }
  if (input.keywords !== undefined) body.q_organization_keyword_tags = input.keywords;

  const res = await ctx.fetch("/api/v1/mixed_companies/search", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /api/v1/mixed_companies/search ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApolloSearchResponse;
  const organizations = Array.isArray(data.organizations) ? data.organizations : [];

  return {
    totalEntries: data.pagination?.total_entries ?? null,
    organizations: organizations.map((organization) => ({
      id: organization.id ?? null,
      name: organization.name ?? null,
      websiteUrl: organization.website_url ?? null,
      primaryDomain: organization.primary_domain ?? null,
      linkedinUrl: organization.linkedin_url ?? null,
      estimatedNumEmployees: organization.estimated_num_employees ?? null,
      city: organization.city ?? null,
      country: organization.country ?? null,
    })),
  };
};
