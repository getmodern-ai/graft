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

/** Characters of message text across a whole conversation, under the runner's 64,000 result. */
const THREAD_TEXT_BUDGET = 40_000;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

function stripHtml(html: string): string {
  return (
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      // One pass, so an entity's output is never read as another entity (&amp;lt; is "&lt;").
      .replace(
        /&(nbsp|amp|lt|gt|quot|#39|apos);/gi,
        (_, name: string) => ENTITIES[name.toLowerCase()] ?? "",
      )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * The body's partial-response mask, nested PART_DEPTH levels: Gmail answers `parts` only as deep
 * as the mask names them, and a forwarded or signed message nests multiparts several levels down.
 */
const PART_DEPTH = 10;

function bodyFieldsMask(): string {
  let part = "mimeType,filename,body";
  for (let level = 0; level < PART_DEPTH; level += 1)
    part = `mimeType,filename,body,parts(${part})`;
  return `id,payload(${part})`;
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
  const bodyFields = bodyFieldsMask();

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

  // The whole conversation's text shares one budget, the newest messages first, so a long thread
  // still fits the runner's result limit rather than arriving as a cut-off prefix.
  let remaining = THREAD_TEXT_BUDGET;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    message.text = message.text.slice(0, remaining);
    remaining -= message.text.length;
  }

  return {
    found: true,
    threadId: thread.id ?? threadId,
    subject: messages[0]?.subject ?? "",
    messages,
  };
};
