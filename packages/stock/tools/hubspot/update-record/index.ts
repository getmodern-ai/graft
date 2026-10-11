export default async (input: Input, ctx: Context) => {
  const objectPaths = {
    contact: "contacts",
    company: "companies",
    deal: "deals",
  } as const;

  const properties: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.properties)) {
    properties[name] = value === null ? "" : String(value);
  }

  const body = { properties };
  const path = `/crm/v3/objects/${objectPaths[input.objectType]}/${encodeURIComponent(input.recordId)}`;
  const res = await ctx.fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
  }

  const result: unknown = await res.json();
  if (typeof result !== "object" || result === null) {
    throw new Error(`PATCH ${path} ${res.status}: HubSpot returned an invalid response`);
  }

  const record = result as { id?: unknown; properties?: unknown };
  if (typeof record.id !== "string" && typeof record.id !== "number") {
    throw new Error(`PATCH ${path} ${res.status}: HubSpot returned no record id`);
  }

  const responseProperties =
    typeof record.properties === "object" && record.properties !== null
      ? (record.properties as Record<string, unknown>)
      : {};
  const updatedProperties: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) {
    updatedProperties[name] = responseProperties[name] ?? null;
  }

  return {
    updated: true,
    id: String(record.id),
    properties: updatedProperties,
  };
};
