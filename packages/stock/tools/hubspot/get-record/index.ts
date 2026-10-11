const objectConfig = {
  contact: {
    apiName: "contacts",
    properties: [
      "firstname",
      "lastname",
      "email",
      "company",
      "jobtitle",
      "phone",
      "lifecyclestage",
      "hubspot_owner_id",
    ],
  },
  company: {
    apiName: "companies",
    properties: [
      "name",
      "domain",
      "industry",
      "city",
      "country",
      "phone",
      "numberofemployees",
      "lifecyclestage",
      "hubspot_owner_id",
    ],
  },
  deal: {
    apiName: "deals",
    properties: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id"],
  },
} as const;

type HubSpotRecord = {
  id?: string;
  properties?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  associations?: Record<string, { results?: Array<{ id?: string }> }>;
};

export default async (input: Input, ctx: Context) => {
  const config = objectConfig[input.objectType];
  const associationTypes = ["contacts", "companies", "deals"] as const;
  const query = new URLSearchParams({
    properties: config.properties.join(","),
    associations: associationTypes.join(","),
  });
  const path = `/crm/v3/objects/${config.apiName}/${encodeURIComponent(input.recordId)}?${query.toString()}`;
  const res = await ctx.fetch(path, { method: "GET" });

  if (res.status === 404) return { found: false };
  if (!res.ok)
    throw new Error(`GET HubSpot ${config.apiName} record ${res.status}: ${await res.text()}`);

  const record = (await res.json()) as HubSpotRecord;
  const properties: Record<string, string | null> = {};
  for (const property of config.properties) {
    properties[property] = record.properties?.[property] ?? null;
  }

  const associations: Record<string, string[]> = {};
  for (const associationType of associationTypes) {
    if (associationType === config.apiName) continue;
    const ids = (record.associations?.[associationType]?.results ?? [])
      .map((association) => association.id)
      .filter((id): id is string => typeof id === "string");
    associations[associationType] = [...new Set(ids)];
  }

  return {
    objectType: input.objectType,
    id: record.id ?? input.recordId,
    properties,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    associations,
  };
};
