type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
};

export default async (input: Input, ctx: Context) => {
  const escapedQuery = input.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}') and trashed=false`;
  const params = new URLSearchParams({
    q,
    pageSize: String(input.limit ?? 10),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });

  const res = await ctx.fetch(`/drive/v3/files?${params.toString()}`, {
    host: "www.googleapis.com",
  });
  if (!res.ok) {
    throw new Error(`GET /drive/v3/files ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as DriveListResponse;
  return {
    files: (data.files ?? []).map((file) => ({
      id: file.id ?? null,
      name: file.name ?? null,
      mimeType: file.mimeType ?? null,
      modifiedTime: file.modifiedTime ?? null,
      webViewLink: file.webViewLink ?? null,
    })),
  };
};
