type ApolloContact = {
  id?: string;
  name?: string;
  email?: string;
  title?: string;
  organization_name?: string;
};

type ApolloUpdateResponse = {
  contact?: ApolloContact;
};

export default async (input: Input, ctx: Context) => {
  const update: Record<string, string | string[]> = {};

  if (input.firstName !== undefined) update.first_name = input.firstName;
  if (input.lastName !== undefined) update.last_name = input.lastName;
  if (input.email !== undefined) update.email = input.email;
  if (input.title !== undefined) update.title = input.title;
  if (input.organizationName !== undefined) update.organization_name = input.organizationName;
  if (input.accountId !== undefined) update.account_id = input.accountId;
  if (input.websiteUrl !== undefined) update.website_url = input.websiteUrl;
  if (input.labelNames !== undefined) update.label_names = input.labelNames;
  if (input.contactStageId !== undefined) update.contact_stage_id = input.contactStageId;
  if (input.phone !== undefined) update.direct_phone = input.phone;

  if (Object.keys(update).length === 0) {
    throw new Error("At least one contact field must be provided to update");
  }

  const path = `/api/v1/contacts/${encodeURIComponent(input.contactId)}`;
  const res = await ctx.fetch(path, {
    host: "api.apollo.io",
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent: true };
  }

  if (!res.ok) {
    throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApolloUpdateResponse;
  const contact = data.contact;
  if (!contact) throw new Error("Apollo returned no contact after the update");

  return {
    updated: true,
    contact: {
      id: contact.id ?? null,
      name: contact.name ?? null,
      email: contact.email ?? null,
      title: contact.title ?? null,
      organization_name: contact.organization_name ?? null,
    },
  };
};
