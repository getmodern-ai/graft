type ApolloContact = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  title?: string | null;
  organization_name?: string | null;
  account_id?: string | null;
};

type ApolloResponse = {
  contact?: ApolloContact | null;
  created?: boolean;
};

export default async (input: Input, ctx: Context) => {
  const body: Record<string, unknown> = {
    first_name: input.firstName,
    last_name: input.lastName,
    run_dedupe: true,
  };

  if (input.email !== undefined) body.email = input.email;
  if (input.title !== undefined) body.title = input.title;
  if (input.organizationName !== undefined) body.organization_name = input.organizationName;
  if (input.accountId !== undefined) body.account_id = input.accountId;
  if (input.websiteUrl !== undefined) body.website_url = input.websiteUrl;
  if (input.labelNames !== undefined) body.label_names = input.labelNames;
  if (input.contactStageId !== undefined) body.contact_stage_id = input.contactStageId;
  if (input.phone !== undefined) body.direct_phone = input.phone;

  const res = await ctx.fetch("/api/v1/contacts", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: true };
  }

  if (!res.ok) {
    throw new Error(`POST /api/v1/contacts ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApolloResponse;
  const contact = data.contact;
  if (!contact) {
    throw new Error("POST /api/v1/contacts succeeded but Apollo returned no contact");
  }

  return {
    created: data.created ?? true,
    contact: {
      id: contact.id ?? null,
      name: contact.name ?? null,
      email: contact.email ?? null,
      title: contact.title ?? null,
      organization_name: contact.organization_name ?? null,
      account_id: contact.account_id ?? null,
    },
  };
};
