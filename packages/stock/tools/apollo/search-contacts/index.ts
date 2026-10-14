type ApolloContact = {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  organization_name?: string | null;
  email?: string | null;
  account_id?: string | null;
  contact_stage_id?: string | null;
};

type ApolloSearchResponse = {
  contacts?: ApolloContact[];
  pagination?: {
    total_entries?: number;
  };
};

/** The input's sort names, Apollo's own fields for them. */
const SORT_FIELDS = {
  last_activity: "contact_last_activity_date",
  last_opened: "contact_email_last_opened_at",
  last_clicked: "contact_email_last_clicked_at",
  newest: "contact_created_at",
} as const;

export default async (input: Input, ctx: Context) => {
  const body: Record<string, string | number | boolean> = {
    page: input.page ?? 1,
    per_page: input.perPage ?? 10,
  };

  if (input.query !== undefined) body.q_keywords = input.query;
  if (input.sortBy !== undefined) body.sort_by_field = SORT_FIELDS[input.sortBy];
  if (input.sortAscending !== undefined) body.sort_ascending = input.sortAscending;

  const res = await ctx.fetch("/api/v1/contacts/search", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /api/v1/contacts/search ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApolloSearchResponse;
  return {
    total_entries: data.pagination?.total_entries ?? 0,
    contacts: (data.contacts ?? []).map((contact) => ({
      id: contact.id ?? null,
      name: contact.name ?? null,
      title: contact.title ?? null,
      organization_name: contact.organization_name ?? null,
      email: contact.email ?? null,
      account_id: contact.account_id ?? null,
      contact_stage_id: contact.contact_stage_id ?? null,
    })),
  };
};
