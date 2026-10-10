type CreateContactResponse = {
  id?: string;
  properties?: { email?: string };
  url?: string;
};

export default async (input: Input, ctx: Context) => {
  const properties: Record<string, string> = { email: input.email };

  if (input.firstName !== undefined) properties.firstname = input.firstName;
  if (input.lastName !== undefined) properties.lastname = input.lastName;
  if (input.phone !== undefined) properties.phone = input.phone;
  if (input.company !== undefined) properties.company = input.company;
  if (input.jobTitle !== undefined) properties.jobtitle = input.jobTitle;
  if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

  const body: {
    properties: Record<string, string>;
    associations?: Array<{
      to: { id: string };
      types: Array<{
        associationCategory: "HUBSPOT_DEFINED";
        associationTypeId: number;
      }>;
    }>;
  } = { properties };

  if (input.companyId !== undefined) {
    body.associations = [
      {
        to: { id: input.companyId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 279,
          },
        ],
      },
    ];
  }

  const res = await ctx.fetch("/crm/v3/objects/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`POST /crm/v3/objects/contacts ${res.status}: ${await res.text()}`);
  }

  const contact = (await res.json()) as CreateContactResponse;
  if (!contact.id) {
    throw new Error("POST /crm/v3/objects/contacts returned no contact id");
  }

  return {
    id: contact.id,
    email: contact.properties?.email ?? null,
    url: contact.url ?? null,
  };
};
