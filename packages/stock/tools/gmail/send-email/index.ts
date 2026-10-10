type GmailMessage = {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
};

function assertSafeHeader(name: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
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

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export default async (input: Input, ctx: Context) => {
  assertSafeHeader("to", input.to);
  assertSafeHeader("subject", input.subject);
  if (input.cc !== undefined) assertSafeHeader("cc", input.cc);
  if (input.bcc !== undefined) assertSafeHeader("bcc", input.bcc);

  const headers = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = wrapBase64(Buffer.from(input.body, "utf8").toString("base64"));
  const message = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
  const raw = Buffer.from(message, "utf8").toString("base64url");

  const res = await ctx.fetch("/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    throw new Error(`POST /users/me/messages/send ${res.status}: ${await res.text()}`);
  }

  const sent = (await res.json()) as GmailMessage;
  if (
    typeof sent.id !== "string" ||
    typeof sent.threadId !== "string" ||
    !Array.isArray(sent.labelIds) ||
    !sent.labelIds.every((label): label is string => typeof label === "string")
  ) {
    throw new Error("Gmail returned an invalid sent-message response");
  }
  return { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds };
};
