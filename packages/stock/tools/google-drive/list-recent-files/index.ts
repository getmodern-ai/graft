type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type FilesListResponse = {
  files?: DriveFile[];
};

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 10;
  const params = new URLSearchParams({
    pageSize: String(limit),
    orderBy: "modifiedTime desc",
    q: "trashed=false",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });

  const res = await ctx.fetch(`/drive/v3/files?${params.toString()}`, {
    method: "GET",
    host: "www.googleapis.com",
  });
  if (!res.ok) {
    throw new Error(`GET /drive/v3/files ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as FilesListResponse;
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
