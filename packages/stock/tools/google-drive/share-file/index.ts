type PermissionResponse = {
  id?: string | null;
  type?: string | null;
  role?: string | null;
  emailAddress?: string | null;
};

export default async (input: Input, ctx: Context) => {
  const role = input.role ?? "reader";
  const notify = input.notify ?? true;
  const query = new URLSearchParams({
    supportsAllDrives: "true",
    sendNotificationEmail: String(notify),
    fields: "id,type,role,emailAddress",
  });

  if (input.message !== undefined) {
    query.set("emailMessage", input.message);
  }

  const path = `/drive/v3/files/${encodeURIComponent(input.fileId)}/permissions?${query.toString()}`;
  const res = await ctx.fetch(path, {
    host: "www.googleapis.com",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "user",
      role,
      emailAddress: input.email,
    }),
  });

  if (!res.ok) {
    throw new Error(`POST Drive permission ${res.status}: ${await res.text()}`);
  }

  const permission = (await res.json()) as PermissionResponse;
  return {
    id: permission.id ?? null,
    type: permission.type ?? null,
    role: permission.role ?? null,
    emailAddress: permission.emailAddress ?? null,
  };
};
