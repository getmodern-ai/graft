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

function encodeSubject(subject: string): string {
  if ([...subject].every((char) => char.charCodeAt(0) < 0x80)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export default async (input: Input, ctx: Context) => {
  assertSafeHeader("to", input.to);
  assertSafeHeader("subject", input.subject);
  assertSafeHeader("cc", input.cc);
  assertSafeHeader("bcc", input.bcc);

  const headers = [
    `To: ${input.to}`,
    ...(input.cc !== undefined ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc !== undefined ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
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
