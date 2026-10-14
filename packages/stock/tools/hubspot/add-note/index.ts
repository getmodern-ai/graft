export default async (input: Input, ctx: Context) => {
  const associationTypeIds = {
    contact: 202,
    company: 190,
    deal: 214,
  } as const;

  const properties: Record<string, string> = {
    hs_note_body: input.body,
    hs_timestamp: input.timestamp ?? new Date().toISOString(),
  };

  if (input.ownerId !== undefined) {
    properties.hubspot_owner_id = input.ownerId;
  }

  const requestBody = {
    properties,
    associations: [
      {
        to: { id: input.recordId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: associationTypeIds[input.objectType],
          },
        ],
      },
    ],
  };

  const res = await ctx.fetch("/crm/v3/objects/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: requestBody };
  }

  if (!res.ok) {
    throw new Error(`POST /crm/v3/objects/notes ${res.status}: ${await res.text()}`);
  }

  const result: unknown = await res.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    (typeof result.id !== "string" && typeof result.id !== "number")
  ) {
    throw new Error("POST /crm/v3/objects/notes succeeded but HubSpot returned no note id");
  }

  return { created: true, id: String(result.id) };
};
