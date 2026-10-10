type DraftResponse = {
  id?: unknown;
  message?: {
    id?: unknown;
    threadId?: unknown;
  };
};

function assertSafeHeader(name: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain line breaks`);
  }
}

/**
 * A non-ASCII subject as RFC 2047 encoded words of at most 75 characters each (45 bytes of UTF-8,
 * never splitting a character), folded one to a line.
 */
function encodeSubject(subject: string): string {
  if ([...subject].every((char) => char.charCodeAt(0) < 0x80)) return subject;
  const words: string[] = [];
  let chunk = "";
  for (const char of subject) {
    if (chunk && Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

type GmailHeader = { name?: string; value?: string };
type GmailThread = { messages?: { payload?: { headers?: GmailHeader[] } }[] };

function headerOf(headers: GmailHeader[], name: string): string {
  const found = headers.find(
    (header) => typeof header.name === "string" && header.name.toLowerCase() === name.toLowerCase(),
  );
  const value = typeof found?.value === "string" ? found.value.trim() : "";
  assertSafeHeader(name, value);
  return value;
}

/**
 * What Gmail needs to file a draft in an existing conversation besides the threadId: the newest
 * message's Message-ID as In-Reply-To, the References chain, and the conversation's subject.
 */
async function replyHeadersOf(
  threadId: string,
  ctx: Context,
): Promise<{ subject: string; inReplyTo: string; references: string }> {
  const query = new URLSearchParams({ format: "metadata" });
  for (const name of ["Subject", "Message-ID", "References"]) query.append("metadataHeaders", name);
  query.set("fields", "messages(payload(headers))");
  const res = await ctx.fetch(`/users/me/threads/${encodeURIComponent(threadId)}?${query}`);
  if (!res.ok) {
    throw new Error(`GET /users/me/threads/${threadId} ${res.status}: ${await res.text()}`);
  }
  const thread = (await res.json()) as GmailThread;
  const messages = thread.messages ?? [];
  const headers = messages[messages.length - 1]?.payload?.headers ?? [];
  const messageId = headerOf(headers, "Message-ID");
  if (!messageId) throw new Error(`The conversation ${threadId} has no message to reply to`);
  const original = headerOf(headers, "Subject");
  return {
    subject: /^\s*re:/i.test(original) ? original : `Re: ${original}`,
    inReplyTo: messageId,
    references: [headerOf(headers, "References"), messageId].filter(Boolean).join(" "),
  };
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export default async (input: Input, ctx: Context) => {
  assertSafeHeader("to", input.to);
  assertSafeHeader("subject", input.subject);
  assertSafeHeader("cc", input.cc);
  assertSafeHeader("bcc", input.bcc);

  const reply = input.threadId !== undefined ? await replyHeadersOf(input.threadId, ctx) : null;
  const subject = reply?.subject ?? input.subject;
  if (subject === undefined) throw new Error("A subject is needed when no threadId is given");

  const headers = [
    `To: ${input.to}`,
    ...(input.cc !== undefined ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc !== undefined ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    ...(reply ? [`In-Reply-To: ${reply.inReplyTo}`, `References: ${reply.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = wrapBase64(Buffer.from(input.body, "utf8").toString("base64"));
  const mimeMessage = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
  const raw = Buffer.from(mimeMessage, "utf8").toString("base64url");
  const message: { raw: string; threadId?: string } = { raw };
  if (input.threadId !== undefined) message.threadId = input.threadId;

  const res = await ctx.fetch("/users/me/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    throw new Error(`POST /users/me/drafts ${res.status}: ${await res.text()}`);
  }

  const draft = (await res.json()) as DraftResponse;
  return {
    draftId: typeof draft.id === "string" ? draft.id : null,
    messageId: typeof draft.message?.id === "string" ? draft.message.id : null,
    threadId: typeof draft.message?.threadId === "string" ? draft.message.threadId : null,
  };
};
