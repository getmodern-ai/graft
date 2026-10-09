type CalendarListEntry = {
  id?: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
};

type CalendarListResponse = {
  items?: CalendarListEntry[];
  nextPageToken?: string;
};

export default async (input: Input, ctx: Context) => {
  void input;
  const calendars: Array<{
    id: string | null;
    summary: string | null;
    description: string | null;
    timeZone: string | null;
    accessRole: string | null;
    primary: boolean;
  }> = [];
  let pageToken: string | undefined;

  do {
    const path = pageToken
      ? `/users/me/calendarList?pageToken=${encodeURIComponent(pageToken)}`
      : "/users/me/calendarList";
    const res = await ctx.fetch(path);
    if (!res.ok) {
      throw new Error(`GET /users/me/calendarList ${res.status}: ${await res.text()}`);
    }

    const page = (await res.json()) as CalendarListResponse;
    for (const calendar of page.items ?? []) {
      calendars.push({
        id: calendar.id ?? null,
        summary: calendar.summary ?? null,
        description: calendar.description ?? null,
        timeZone: calendar.timeZone ?? null,
        accessRole: calendar.accessRole ?? null,
        primary: calendar.primary === true,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return { calendars };
};
