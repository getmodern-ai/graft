export default async (input: Input, ctx: Context) => {
  const recipients = (addresses: string[]) =>
    addresses.map((address) => ({ emailAddress: { address } }));

  const requestBody = {
    message: {
      subject: input.subject,
      body: {
        contentType: input.bodyType === "html" ? "HTML" : "Text",
        content: input.body,
      },
      toRecipients: recipients(input.to),
      ccRecipients: recipients(input.cc ?? []),
      bccRecipients: recipients(input.bcc ?? []),
    },
    saveToSentItems: input.saveToSentItems ?? true,
  };

  const res = await ctx.fetch("/me/sendMail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { sent: false, preview: requestBody };
  }

  if (res.status !== 202) {
    throw new Error(`POST /me/sendMail ${res.status}: ${await res.text()}`);
  }

  return { sent: true };
};
