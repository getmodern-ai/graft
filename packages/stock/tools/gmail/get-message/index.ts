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

/** The charset a Content-Type header declares, lower-cased, or null. */
function charsetOf(contentType: string): string | null {
  const match = contentType.match(/;\s*charset\s*=\s*"?([^";\s]+)"?/i);
  return match ? match[1].toLowerCase() : null;
}

/** A text part's bytes in the charset it declares; UTF-8 when it declares none or one Node lacks. */
function decodeText(data: string, charset: string | null): string {
  const bytes = Buffer.from(data, "base64url");
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // A label TextDecoder does not know: read it as UTF-8 rather than fail the message.
    }
  }
  return bytes.toString("utf8");
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

/**
 * The body's partial-response mask, nested PART_DEPTH levels: Gmail answers `parts` only as deep
 * as the mask names them, and a forwarded or signed message nests multiparts several levels down.
 */
const PART_DEPTH = 10;

function bodyFieldsMask(): string {
  let part = "mimeType,filename,headers,body";
  for (let level = 1; level < PART_DEPTH; level += 1) {
    part = `mimeType,filename,headers,body,parts(${part})`;
  }
  // The top level's headers are the whole message's; its charset comes from the metadata read.
  return `id,payload(mimeType,filename,body,parts(${part}))`;
}

function partHeader(part: GmailPart, name: string): string {
  const wanted = name.toLowerCase();
  return part.headers?.find((header) => header.name?.toLowerCase() === wanted)?.value ?? "";
}

function stripHtml(html: string): string {
  return (
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      // One pass, so an entity's output is never read as another entity (&amp;lt; is "&lt;").
      .replace(
        /&(nbsp|amp|lt|gt|quot|#39);/gi,
        (_, name: string) => ENTITIES[name.toLowerCase()] ?? "",
      )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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
  for (const header of ["From", "To", "Cc", "Subject", "Date", "Content-Type"]) {
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
    fields: bodyFieldsMask(),
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

  function walk(part: GmailPart, charset: string | null): void {
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
      const decoded = decodeText(body.data, charset);
      if (part.mimeType === "text/plain") plainText.push(decoded);
      if (part.mimeType === "text/html") htmlText.push(decoded);
    }
    for (const child of part.parts ?? []) {
      walk(child, charsetOf(partHeader(child, "Content-Type")));
    }
  }

  const topCharset = charsetOf(
    metadata.payload?.headers?.find((header) => header.name?.toLowerCase() === "content-type")
      ?.value ?? "",
  );
  if (full.payload) walk(full.payload, topCharset);

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
