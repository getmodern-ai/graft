type Calendar = {
  id?: string;
  name?: string;
  color?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: {
    name?: string;
    address?: string;
  } | null;
};

type CalendarResponse = {
  value?: Calendar[];
  "@odata.nextLink"?: string;
};

export default async (_input: Input, ctx: Context) => {
  let nextLink: string | null =
    "/me/calendars?$top=100&$select=id,name,color,isDefaultCalendar,canEdit,owner";
  const calendars: Calendar[] = [];
  let pagesRead = 0;

  while (nextLink !== null && pagesRead < 5) {
    const res = await ctx.fetch(nextLink);
    if (!res.ok) {
      throw new Error(`GET /me/calendars ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as CalendarResponse;
    if (!Array.isArray(data.value)) {
      throw new Error("GET /me/calendars returned an invalid calendar collection");
    }
    if (data["@odata.nextLink"] !== undefined && typeof data["@odata.nextLink"] !== "string") {
      throw new Error("GET /me/calendars returned an invalid pagination link");
    }

    calendars.push(...data.value);
    nextLink = data["@odata.nextLink"] ?? null;
    pagesRead += 1;
  }

  return {
    calendars: calendars.map((calendar) => ({
      id: calendar.id ?? null,
      name: calendar.name ?? null,
      color: calendar.color ?? null,
      isDefaultCalendar: calendar.isDefaultCalendar ?? false,
      canEdit: calendar.canEdit ?? false,
      owner: calendar.owner
        ? {
            name: calendar.owner.name ?? null,
            address: calendar.owner.address ?? null,
          }
        : null,
    })),
    complete: nextLink === null,
  };
};
