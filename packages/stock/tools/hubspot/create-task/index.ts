type Association = {
  to: { id: string };
  types: Array<{
    associationCategory: "HUBSPOT_DEFINED";
    associationTypeId: number;
  }>;
};

type TaskRequest = {
  properties: Record<string, string>;
  associations?: Association[];
};

export default async (input: Input, ctx: Context) => {
  if ((input.objectType === undefined) !== (input.recordId === undefined)) {
    throw new Error("objectType and recordId must be provided together");
  }

  const properties: Record<string, string> = {
    hs_task_subject: input.subject,
    hs_task_status: "NOT_STARTED",
    hs_task_type: input.taskType ?? "TODO",
    hs_timestamp: input.dueDate ?? new Date().toISOString(),
  };

  if (input.body !== undefined) properties.hs_task_body = input.body;
  if (input.priority !== undefined) properties.hs_task_priority = input.priority;
  if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

  const requestBody: TaskRequest = { properties };

  if (input.objectType !== undefined && input.recordId !== undefined) {
    const associationTypeIds = {
      contact: 204,
      company: 192,
      deal: 216,
    } satisfies Record<"contact" | "company" | "deal", number>;

    requestBody.associations = [
      {
        to: { id: input.recordId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: associationTypeIds[input.objectType],
          },
        ],
      },
    ];
  }

  const res = await ctx.fetch("/crm/v3/objects/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: requestBody };
  }

  if (!res.ok) {
    throw new Error(`POST /crm/v3/objects/tasks ${res.status}: ${await res.text()}`);
  }

  const result: unknown = await res.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    (typeof result.id !== "string" && typeof result.id !== "number")
  ) {
    throw new Error("POST /crm/v3/objects/tasks succeeded but HubSpot returned no task id");
  }

  return { created: true, id: result.id };
};
