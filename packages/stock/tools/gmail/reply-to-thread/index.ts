const HEADER_NAMES = [
  "From",
  "Reply-To",
  "To",
  "Cc",
  "Subject",
  "Message-ID",
  "Message-Id",
  "References",
] as const;

type GmailHeader = { name?: string; value?: string };
type GmailMessage = { id?: string; payload?: { headers?: GmailHeader[] } };
type GmailThread = { id?: string; messages?: GmailMessage[] };
type GmailProfile = { emailAddress?: string };
type SendResponse = { id?: string; threadId?: string };

function safeHeader(value: string, name: string): string {
  if (/\r|\n/.test(value)) throw new Error(`${name} contains a line break`);
  return value.trim();
}

function getHeader(headers: GmailHeader[], name: string): string {
  const found = headers.find(
    (header) => typeof header.name === "string" && header.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof found?.value === "string" ? safeHeader(found.value, name) : "";
}

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angleDepth += 1;
    } else if (!quoted && character === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (!quoted && angleDepth === 0 && character === ",") {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }

  const finalPart = value.slice(start).trim();
  if (finalPart) parts.push(finalPart);
  return parts;
}

function addressOf(mailbox: string): string {
  const angle = mailbox.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) return angle[1].toLowerCase();
  const bare = mailbox.match(/(?:^|\s)([^\s,;<>]+@[^\s,;<>]+)(?:$|\s)/);
  return (bare?.[1] ?? mailbox).trim().toLowerCase();
}

function addRecipients(
  recipients: string[],
  seen: Set<string>,
  value: string,
  ownAddress: string,
): void {
  for (const mailbox of splitAddresses(value)) {
    const safeMailbox = safeHeader(mailbox, "recipient");
    const address = addressOf(safeMailbox);
    if (!address || address === ownAddress || seen.has(address)) continue;
    seen.add(address);
    recipients.push(safeMailbox);
  }
}

function encodeBody(body: string): string {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export default async (input: Input, ctx: Context) => {
  void HEADER_NAMES;
  const threadPath = `/users/me/threads/${encodeURIComponent(input.threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Cc&fields=id%2Cmessages(id%2Cpayload(headers))`;
  const threadResponse = await ctx.fetch(threadPath);
  if (!threadResponse.ok) {
    throw new Error(`GET thread ${threadResponse.status}: ${await threadResponse.text()}`);
  }

  const thread = (await threadResponse.json()) as GmailThread;
  const messages = thread.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) throw new Error("The Gmail thread contains no messages");

  const headers = lastMessage.payload?.headers ?? [];
  const from = getHeader(headers, "From");
  const replyTo = getHeader(headers, "Reply-To");
  const originalTo = getHeader(headers, "To");
  const originalCc = getHeader(headers, "Cc");
  const originalSubject = getHeader(headers, "Subject");
  const messageId = getHeader(headers, "Message-ID") || getHeader(headers, "Message-Id");
  const originalReferences = getHeader(headers, "References");
  if (!from && !replyTo) throw new Error("The last message has neither Reply-To nor From");
  if (!messageId) throw new Error("The last message has no Message-ID header");

  // The person's own address, always: a reply never goes to the person, and when the last message
  // is the person's own, a reply follows it up to the people it was sent to, as Gmail's does.
  const profileResponse = await ctx.fetch("/users/me/profile");
  if (!profileResponse.ok) {
    throw new Error(`GET profile ${profileResponse.status}: ${await profileResponse.text()}`);
  }
  const profile = (await profileResponse.json()) as GmailProfile;
  if (!profile.emailAddress) throw new Error("The Gmail profile has no emailAddress");
  const ownAddress = safeHeader(profile.emailAddress, "profile emailAddress").toLowerCase();
  const sentByOwner = from !== "" && addressOf(from) === ownAddress;

  const recipients: string[] = [];
  const seen = new Set<string>();
  if (sentByOwner) {
    addRecipients(recipients, seen, originalTo, ownAddress);
  } else {
    addRecipients(recipients, seen, replyTo || from, ownAddress);
    if (input.replyAll === true) addRecipients(recipients, seen, originalTo, ownAddress);
  }
  if (input.replyAll === true) addRecipients(recipients, seen, originalCc, ownAddress);
  if (recipients.length === 0) throw new Error("No reply recipients remain");

  const subject = /^\s*re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
  const references = [originalReferences, messageId].filter(Boolean).join(" ");
  const rawMessage = [
    `To: ${safeHeader(recipients.join(", "), "To")}`,
    `Subject: ${safeHeader(subject, "Subject")}`,
    `In-Reply-To: ${safeHeader(messageId, "In-Reply-To")}`,
    `References: ${safeHeader(references, "References")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(input.body),
  ].join("\r\n");

  const raw = Buffer.from(rawMessage, "utf8").toString("base64url");
  const sendResponse = await ctx.fetch("/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, threadId: input.threadId }),
  });
  if (!sendResponse.ok) {
    throw new Error(`POST send message ${sendResponse.status}: ${await sendResponse.text()}`);
  }

  const sent = (await sendResponse.json()) as SendResponse;
  return {
    id: typeof sent.id === "string" ? sent.id : null,
    threadId: typeof sent.threadId === "string" ? sent.threadId : input.threadId,
    to: recipients,
  };
};
