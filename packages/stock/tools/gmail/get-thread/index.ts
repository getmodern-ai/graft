type GmailHeader = {
  name?: string;
  value?: string;
};

type GmailBody = {
  attachmentId?: string;
  size?: number;
  data?: string;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
};

type GmailThread = {
  id?: string;
  messages?: GmailMessage[];
};

type GmailThreadList = {
  threads?: Array<{ id?: string }>;
};

type Attachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
};

function header(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((item) => item.name?.toLowerCase() === wanted)?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectParts(root: GmailPart | undefined): {
  plain: string[];
  html: string[];
  attachments: Attachment[];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Attachment[] = [];

  function walk(part: GmailPart): void {
    const mimeType = part.mimeType ?? "application/octet-stream";
    const filename = part.filename ?? "";
    const body = part.body;

    if (body?.attachmentId) {
      attachments.push({
        filename,
        mimeType,
        size: body.size ?? 0,
        attachmentId: body.attachmentId,
      });
    } else if (body?.data) {
      const decoded = decodeBase64Url(body.data);
      if (mimeType.toLowerCase().startsWith("text/plain")) plain.push(decoded);
      else if (mimeType.toLowerCase().startsWith("text/html")) html.push(decoded);
    }

    for (const child of part.parts ?? []) walk(child);
  }

  if (root) walk(root);
  return { plain, html, attachments };
}

export default async (input: Input, ctx: Context) => {
  let threadId = input.threadId?.trim() ?? "";

  if (!threadId) {
    const listRes = await ctx.fetch(
      "/users/me/threads?maxResults=1&labelIds=INBOX&fields=threads(id)",
    );
    if (!listRes.ok) {
      throw new Error(`GET /users/me/threads ${listRes.status}: ${await listRes.text()}`);
    }
    const list = (await listRes.json()) as GmailThreadList;
    threadId = list.threads?.[0]?.id ?? "";
    if (!threadId) return { found: false };
  }

  const metadataQuery = new URLSearchParams();
  metadataQuery.set("format", "metadata");
  for (const name of ["From", "To", "Cc", "Subject", "Date"]) {
    metadataQuery.append("metadataHeaders", name);
  }
  metadataQuery.set("fields", "id,messages(id,threadId,labelIds,snippet,payload(headers))");
  const threadPath = `/users/me/threads/${encodeURIComponent(threadId)}?${metadataQuery.toString()}`;
  const threadRes = await ctx.fetch(threadPath);
  if (!threadRes.ok) {
    throw new Error(`GET /users/me/threads/{id} ${threadRes.status}: ${await threadRes.text()}`);
  }

  const thread = (await threadRes.json()) as GmailThread;
  const messages = [];
  const bodyFields =
    "id,payload(mimeType,filename,body,parts(mimeType,filename,body,parts(mimeType,filename,body,parts(mimeType,filename,body))))";

  for (const metadata of thread.messages ?? []) {
    const messageId = metadata.id ?? "";
    if (!messageId) continue;

    const messageQuery = new URLSearchParams({ format: "full", fields: bodyFields });
    const messagePath = `/users/me/messages/${encodeURIComponent(messageId)}?${messageQuery.toString()}`;
    const messageRes = await ctx.fetch(messagePath);
    if (!messageRes.ok) {
      throw new Error(
        `GET /users/me/messages/{id} ${messageRes.status}: ${await messageRes.text()}`,
      );
    }

    const bodyMessage = (await messageRes.json()) as GmailMessage;
    const content = collectParts(bodyMessage.payload);
    const text = (
      content.plain.length > 0 ? content.plain.join("\n\n") : stripHtml(content.html.join("\n\n"))
    ).slice(0, 20000);
    const labelIds = metadata.labelIds ?? [];

    messages.push({
      id: metadata.id ?? bodyMessage.id ?? "",
      threadId: metadata.threadId ?? thread.id ?? threadId,
      from: header(metadata.payload, "From"),
      to: header(metadata.payload, "To"),
      cc: header(metadata.payload, "Cc"),
      subject: header(metadata.payload, "Subject"),
      date: header(metadata.payload, "Date"),
      labelIds,
      unread: labelIds.includes("UNREAD"),
      snippet: metadata.snippet ?? "",
      text,
      attachments: content.attachments,
    });
  }

  return {
    found: true,
    threadId: thread.id ?? threadId,
    subject: messages[0]?.subject ?? "",
    messages,
  };
};
