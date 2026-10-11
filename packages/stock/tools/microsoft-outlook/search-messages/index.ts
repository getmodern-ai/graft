type EmailAddress = {
  name?: string | null;
  address?: string | null;
};

type Recipient = {
  emailAddress?: EmailAddress | null;
};

type GraphMessage = {
  id?: string | null;
  subject?: string | null;
  from?: Recipient | null;
  toRecipients?: Recipient[] | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  isRead?: boolean | null;
  hasAttachments?: boolean | null;
  conversationId?: string | null;
  webLink?: string | null;
};

type GraphResponse = {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
};

const address = (recipient: Recipient | null | undefined) => ({
  name: recipient?.emailAddress?.name ?? null,
  address: recipient?.emailAddress?.address ?? null,
});

const escapeSearch = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export default async (input: Input, ctx: Context) => {
  const top = input.top ?? 10;
  const basePath = input.folder
    ? `/me/mailFolders/${encodeURIComponent(input.folder)}/messages`
    : "/me/messages";

  const params = new URLSearchParams();
  params.set(
    "$select",
    "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink",
  );
  params.set("$top", String(input.query && input.unreadOnly ? 50 : top));

  if (input.query) {
    let search = escapeSearch(input.query);
    if (input.from) search += ` from:${escapeSearch(input.from)}`;
    params.set("$search", `"${search}"`);
  } else {
    const filters: string[] = [];
    if (input.from || input.unreadOnly) {
      filters.push("receivedDateTime ge 1900-01-01T00:00:00Z");
    }
    if (input.from) {
      const escapedSender = input.from.replaceAll("'", "''");
      filters.push(`from/emailAddress/address eq '${escapedSender}'`);
    }
    if (input.unreadOnly) filters.push("isRead eq false");
    if (filters.length > 0) params.set("$filter", filters.join(" and "));
    params.set("$orderby", "receivedDateTime desc");
  }

  let path: string | undefined = `${basePath}?${params.toString()}`;
  const messages: GraphMessage[] = [];
  let pagesRead = 0;

  while (path && pagesRead < 5 && messages.length < top) {
    const res = await ctx.fetch(path);
    if (!res.ok) throw new Error(`GET ${basePath} ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as GraphResponse;
    const page = Array.isArray(data.value) ? data.value : [];
    if (input.query && input.unreadOnly) {
      messages.push(...page.filter((message) => message.isRead === false));
    } else {
      messages.push(...page);
    }

    pagesRead += 1;
    const nextLink = data["@odata.nextLink"];
    path = input.query && input.unreadOnly && nextLink ? nextLink : undefined;
  }

  const complete = !(path && pagesRead >= 5 && messages.length < top);

  return {
    messages: messages.slice(0, top).map((message) => ({
      id: message.id ?? null,
      subject: message.subject ?? null,
      from: address(message.from),
      toRecipients: (message.toRecipients ?? []).map(address),
      receivedDateTime: message.receivedDateTime ?? null,
      bodyPreview: message.bodyPreview ?? null,
      isRead: message.isRead ?? null,
      hasAttachments: message.hasAttachments ?? null,
      conversationId: message.conversationId ?? null,
      webLink: message.webLink ?? null,
    })),
    complete,
  };
};
