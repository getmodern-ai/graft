export default async (input: Input, ctx: Context) => {
  const properties: Record<string, string> = { name: input.name };

  if (input.domain !== undefined) properties.domain = input.domain;
  if (input.industry !== undefined) properties.industry = input.industry;
  if (input.city !== undefined) properties.city = input.city;
  if (input.country !== undefined) properties.country = input.country;
  if (input.phone !== undefined) properties.phone = input.phone;
  if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

  const body = { properties };
  const res = await ctx.fetch("/crm/v3/objects/companies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`POST /crm/v3/objects/companies ${res.status}: ${await res.text()}`);
  }

  const company: unknown = await res.json();
  if (
    typeof company !== "object" ||
    company === null ||
    !("id" in company) ||
    typeof company.id !== "string"
  ) {
    throw new Error("HubSpot created the company but returned no company id");
  }

  let name = input.name;
  if (
    "properties" in company &&
    typeof company.properties === "object" &&
    company.properties !== null &&
    "name" in company.properties &&
    typeof company.properties.name === "string"
  ) {
    name = company.properties.name;
  }

  return { created: true, id: company.id, name };
};
