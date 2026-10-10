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
};

const address = (recipient: Recipient | null | undefined) => ({
  name: recipient?.emailAddress?.name ?? null,
  address: recipient?.emailAddress?.address ?? null,
});

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
  params.set("$top", String(top));

  if (input.query) {
    // $search's value is one double-quoted string; a quote inside it is escaped with a backslash.
    params.set("$search", `"${input.query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  } else {
    const filters: string[] = [];
    if (input.from) {
      const escapedSender = input.from.replaceAll("'", "''");
      filters.push(`from/emailAddress/address eq '${escapedSender}'`);
    }
    if (input.unreadOnly) filters.push("isRead eq false");
    if (filters.length > 0) params.set("$filter", filters.join(" and "));
    params.set("$orderby", "receivedDateTime desc");
  }

  const path = `${basePath}?${params.toString()}`;
  const res = await ctx.fetch(path);
  if (!res.ok) throw new Error(`GET ${basePath} ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as GraphResponse;
  let messages = Array.isArray(data.value) ? data.value : [];

  if (input.query && input.from) {
    const wanted = input.from.toLowerCase();
    messages = messages.filter(
      (message) => message.from?.emailAddress?.address?.toLowerCase() === wanted,
    );
  }
  if (input.query && input.unreadOnly) {
    messages = messages.filter((message) => message.isRead === false);
  }

  return {
    messages: messages.map((message) => ({
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
  };
};
