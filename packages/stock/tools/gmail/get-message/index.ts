type GmailBody = {
  attachmentId?: string;
  size?: number;
  data?: string;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: GmailBody;
  parts?: GmailPart[];
};

type GmailHeader = {
  name?: string;
  value?: string;
};

type MetadataMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: { headers?: GmailHeader[] };
};

type FullMessage = {
  id?: string;
  payload?: GmailPart;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default async (input: Input, ctx: Context) => {
  let messageId = input.messageId;

  if (!messageId) {
    const listQuery = new URLSearchParams({
      maxResults: "1",
      labelIds: "INBOX",
      fields: "messages(id)",
    });
    const listRes = await ctx.fetch(`/users/me/messages?${listQuery}`);
    if (!listRes.ok) {
      throw new Error(`GET /users/me/messages ${listRes.status}: ${await listRes.text()}`);
    }
    const list = (await listRes.json()) as { messages?: Array<{ id?: string }> };
    messageId = list.messages?.[0]?.id;
    if (!messageId) return { found: false };
  }

  const encodedId = encodeURIComponent(messageId);
  const metadataQuery = new URLSearchParams();
  metadataQuery.set("format", "metadata");
  for (const header of ["From", "To", "Cc", "Subject", "Date"]) {
    metadataQuery.append("metadataHeaders", header);
  }
  metadataQuery.set("fields", "id,threadId,labelIds,snippet,payload(headers)");

  const metadataRes = await ctx.fetch(`/users/me/messages/${encodedId}?${metadataQuery}`);
  if (!metadataRes.ok) {
    throw new Error(`GET message metadata ${metadataRes.status}: ${await metadataRes.text()}`);
  }
  const metadata = (await metadataRes.json()) as MetadataMessage;

  const fullQuery = new URLSearchParams({
    format: "full",
    fields:
      "id,payload(mimeType,filename,body,parts(mimeType,filename,body,parts(mimeType,filename,body,parts(mimeType,filename,body))))",
  });
  const fullRes = await ctx.fetch(`/users/me/messages/${encodedId}?${fullQuery}`);
  if (!fullRes.ok) {
    throw new Error(`GET message body ${fullRes.status}: ${await fullRes.text()}`);
  }
  const full = (await fullRes.json()) as FullMessage;

  const plainText: string[] = [];
  const htmlText: string[] = [];
  const attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }> = [];

  function walk(part: GmailPart): void {
    const body = part.body;
    if (part.filename && body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: body.size ?? 0,
        attachmentId: body.attachmentId,
      });
    }
    if (body?.data) {
      const decoded = decodeBase64Url(body.data);
      if (part.mimeType === "text/plain") plainText.push(decoded);
      if (part.mimeType === "text/html") htmlText.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  }

  if (full.payload) walk(full.payload);

  const headers = metadata.payload?.headers ?? [];
  const headerValue = (name: string): string =>
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  const text = (plainText.length > 0 ? plainText.join("\n") : stripHtml(htmlText.join("\n"))).slice(
    0,
    20000,
  );
  const labelIds = metadata.labelIds ?? [];

  return {
    found: true,
    id: metadata.id ?? full.id ?? messageId,
    threadId: metadata.threadId ?? "",
    from: headerValue("From"),
    to: headerValue("To"),
    cc: headerValue("Cc"),
    subject: headerValue("Subject"),
    date: headerValue("Date"),
    labelIds,
    unread: labelIds.includes("UNREAD"),
    snippet: metadata.snippet ?? "",
    text,
    attachments,
  };
};
