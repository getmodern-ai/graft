type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type ListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

export default async (input: Input, ctx: Context) => {
  const folderId = input.folderId ?? "root";
  const escapedFolderId = folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const params = new URLSearchParams({
    q: `'${escapedFolderId}' in parents and trashed=false`,
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
    pageSize: String(input.limit ?? 50),
  });

  if (input.pageToken !== undefined) params.set("pageToken", input.pageToken);

  const res = await ctx.fetch(`/drive/v3/files?${params.toString()}`, {
    host: "www.googleapis.com",
  });
  if (!res.ok) throw new Error(`GET /drive/v3/files ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as ListResponse;
  return {
    files: (data.files ?? []).map((file) => ({
      id: file.id ?? null,
      name: file.name ?? null,
      mimeType: file.mimeType ?? null,
      isFolder: file.mimeType === "application/vnd.google-apps.folder",
      modifiedTime: file.modifiedTime ?? null,
      webViewLink: file.webViewLink ?? null,
    })),
    nextPageToken: data.nextPageToken ?? null,
  };
};
