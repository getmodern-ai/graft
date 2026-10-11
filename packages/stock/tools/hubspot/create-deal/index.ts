export default async (input: Input, ctx: Context) => {
  const pipelineId = input.pipelineId ?? "default";

  const properties: Record<string, string> = {
    dealname: input.name,
    pipeline: pipelineId,
    dealstage: input.stageId,
  };

  if (input.amount !== undefined) properties.amount = String(input.amount);
  if (input.closeDate !== undefined) properties.closedate = input.closeDate;
  if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

  const associations: Array<{
    to: { id: string };
    types: Array<{
      associationCategory: "HUBSPOT_DEFINED";
      associationTypeId: number;
    }>;
  }> = [];

  if (input.contactId !== undefined) {
    associations.push({
      to: { id: input.contactId },
      types: [
        {
          associationCategory: "HUBSPOT_DEFINED",
          associationTypeId: 3,
        },
      ],
    });
  }

  if (input.companyId !== undefined) {
    associations.push({
      to: { id: input.companyId },
      types: [
        {
          associationCategory: "HUBSPOT_DEFINED",
          associationTypeId: 341,
        },
      ],
    });
  }

  const body: {
    properties: Record<string, string>;
    associations?: typeof associations;
  } = { properties };

  if (associations.length > 0) body.associations = associations;

  const res = await ctx.fetch("/crm/v3/objects/deals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`POST /crm/v3/objects/deals ${res.status}: ${await res.text()}`);
  }

  const deal: unknown = await res.json();
  if (
    typeof deal !== "object" ||
    deal === null ||
    !("id" in deal) ||
    (typeof deal.id !== "string" && typeof deal.id !== "number")
  ) {
    throw new Error("POST /crm/v3/objects/deals succeeded but returned no deal id");
  }

  return {
    created: true,
    id: String(deal.id),
    name: input.name,
    stageId: input.stageId,
    pipelineId,
  };
};
