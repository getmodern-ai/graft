export default async (input: Input, ctx: Context) => {
  const message = {
    subject: input.subject,
    body: {
      contentType: input.bodyType === "html" ? "HTML" : "Text",
      content: input.body,
    },
    toRecipients: (input.to ?? []).map((address) => ({
      emailAddress: { address },
    })),
    ccRecipients: (input.cc ?? []).map((address) => ({
      emailAddress: { address },
    })),
    bccRecipients: (input.bcc ?? []).map((address) => ({
      emailAddress: { address },
    })),
  };

  const res = await ctx.fetch("/me/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: message };
  }

  if (!res.ok) {
    throw new Error(`POST /me/messages ${res.status}: ${await res.text()}`);
  }

  const draft = (await res.json()) as { id?: string; webLink?: string };
  return {
    created: true,
    id: draft.id ?? null,
    webLink: draft.webLink ?? null,
  };
};
