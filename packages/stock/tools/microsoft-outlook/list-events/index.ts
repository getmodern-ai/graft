type EmailAddress = {
  name?: string | null;
  address?: string | null;
};

type Recipient = {
  emailAddress?: EmailAddress | null;
};

type Attendee = Recipient & {
  status?: {
    response?: string | null;
  } | null;
};

type DateTimeTimeZone = {
  dateTime?: string | null;
  timeZone?: string | null;
};

type Event = {
  id?: string | null;
  subject?: string | null;
  start?: DateTimeTimeZone | null;
  end?: DateTimeTimeZone | null;
  location?: {
    displayName?: string | null;
  } | null;
  organizer?: Recipient | null;
  attendees?: Attendee[] | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  showAs?: string | null;
  responseStatus?: {
    response?: string | null;
    time?: string | null;
  } | null;
  webLink?: string | null;
  onlineMeeting?: {
    joinUrl?: string | null;
    conferenceId?: string | null;
    tollNumber?: string | null;
    tollFreeNumbers?: string[] | null;
  } | null;
};

type CalendarViewResponse = {
  value?: Event[];
};

export default async (input: Input, ctx: Context) => {
  const start = input.start ?? new Date().toISOString();
  const startMilliseconds = Date.parse(start);
  if (!Number.isFinite(startMilliseconds)) {
    throw new Error("start must be a valid ISO 8601 date-time");
  }

  const end = input.end ?? new Date(startMilliseconds + 7 * 24 * 60 * 60 * 1000).toISOString();
  const endMilliseconds = Date.parse(end);
  if (!Number.isFinite(endMilliseconds)) {
    throw new Error("end must be a valid ISO 8601 date-time");
  }
  if (endMilliseconds <= startMilliseconds) {
    throw new Error("end must be after start");
  }

  const timeZone = input.timeZone ?? "UTC";
  if (!/^[A-Za-z0-9_+\-./ ]+$/.test(timeZone)) {
    throw new Error("timeZone must be an IANA or Windows time zone name");
  }

  const top = input.top ?? 50;
  const basePath = input.calendarId
    ? `/me/calendars/${encodeURIComponent(input.calendarId)}/calendarView`
    : "/me/calendarView";
  const query = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    $orderby: "start/dateTime",
    $top: String(top),
    $select:
      "id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,showAs,responseStatus,webLink,onlineMeeting",
  });

  const res = await ctx.fetch(`${basePath}?${query.toString()}`, {
    method: "GET",
    headers: {
      Prefer: `outlook.timezone="${timeZone}"`,
    },
  });
  if (!res.ok) {
    throw new Error(`GET calendarView ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as CalendarViewResponse;
  const events = Array.isArray(data.value) ? data.value : [];

  return {
    events: events.map((event) => ({
      id: event.id ?? null,
      subject: event.subject ?? null,
      start: event.start?.dateTime ?? null,
      startTimeZone: event.start?.timeZone ?? null,
      end: event.end?.dateTime ?? null,
      endTimeZone: event.end?.timeZone ?? null,
      location: event.location?.displayName ?? null,
      organizerName: event.organizer?.emailAddress?.name ?? null,
      organizerAddress: event.organizer?.emailAddress?.address ?? null,
      attendees: (event.attendees ?? []).map((attendee) => ({
        name: attendee.emailAddress?.name ?? null,
        address: attendee.emailAddress?.address ?? null,
        response: attendee.status?.response ?? null,
      })),
      isAllDay: event.isAllDay ?? false,
      isCancelled: event.isCancelled ?? false,
      showAs: event.showAs ?? null,
      response: event.responseStatus?.response ?? null,
      responseTime: event.responseStatus?.time ?? null,
      webLink: event.webLink ?? null,
      onlineMeetingUrl: event.onlineMeeting?.joinUrl ?? null,
      onlineMeetingConferenceId: event.onlineMeeting?.conferenceId ?? null,
      onlineMeetingTollNumber: event.onlineMeeting?.tollNumber ?? null,
      onlineMeetingTollFreeNumbers: event.onlineMeeting?.tollFreeNumbers ?? [],
    })),
  };
};
