type GmailMessageRef = {
  id?: string;
  threadId?: string;
};

type GmailListResponse = {
  messages?: GmailMessageRef[];
  resultSizeEstimate?: number;
};

type GmailHeader = {
  name?: string;
  value?: string;
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: {
    headers?: GmailHeader[];
  };
};

export default async (input: Input, ctx: Context) => {
  const listParams = new URLSearchParams({
    q: input.query,
    maxResults: String(input.maxResults),
  });
  const listPath = `/users/me/messages?${listParams.toString()}`;
  const listResponse = await ctx.fetch(listPath);
  if (!listResponse.ok) {
    throw new Error(`GET /users/me/messages ${listResponse.status}: ${await listResponse.text()}`);
  }

  const list = (await listResponse.json()) as GmailListResponse;
  const refs = list.messages ?? [];
  const messages = [];

  for (const ref of refs) {
    if (!ref.id) {
      throw new Error("Gmail returned a message without an id");
    }

    const params = new URLSearchParams({ format: "metadata" });
    for (const header of ["From", "To", "Subject", "Date"]) {
      params.append("metadataHeaders", header);
    }
    const detailPath = `/users/me/messages/${encodeURIComponent(ref.id)}?${params.toString()}`;
    const detailResponse = await ctx.fetch(detailPath);
    if (!detailResponse.ok) {
      throw new Error(
        `GET /users/me/messages/{id} ${detailResponse.status}: ${await detailResponse.text()}`,
      );
    }

    const message = (await detailResponse.json()) as GmailMessage;
    const headers = message.payload?.headers ?? [];
    const headerValue = (name: string) =>
      headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
    const labelIds = message.labelIds ?? [];

    messages.push({
      id: message.id ?? ref.id,
      threadId: message.threadId ?? ref.threadId ?? "",
      from: headerValue("From"),
      to: headerValue("To"),
      subject: headerValue("Subject"),
      date: headerValue("Date"),
      snippet: message.snippet ?? "",
      labelIds,
      unread: labelIds.includes("UNREAD"),
    });
  }

  return {
    messages,
    resultSizeEstimate: list.resultSizeEstimate ?? 0,
  };
};
