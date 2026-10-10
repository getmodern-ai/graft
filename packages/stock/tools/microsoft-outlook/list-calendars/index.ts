type CalendarResponse = {
  value?: Array<{
    id?: string;
    name?: string;
    color?: string;
    isDefaultCalendar?: boolean;
    canEdit?: boolean;
    owner?: {
      name?: string;
      address?: string;
    } | null;
  }>;
};

export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(
    "/me/calendars?$top=100&$select=id,name,color,isDefaultCalendar,canEdit,owner",
  );
  if (!res.ok) {
    throw new Error(`GET /me/calendars ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as CalendarResponse;
  if (!Array.isArray(data.value)) {
    throw new Error("GET /me/calendars returned an invalid calendar collection");
  }

  return {
    calendars: data.value.map((calendar) => ({
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
  };
};
