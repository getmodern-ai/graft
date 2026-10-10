type DriveFile = {
  id?: string;
  name?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type DriveFileList = {
  files?: DriveFile[];
};

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 10;
  let query = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";

  if (input.query !== undefined) {
    const escapedQuery = input.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    query += ` and name contains '${escapedQuery}'`;
  }

  const params = new URLSearchParams({
    q: query,
    orderBy: "modifiedTime desc",
    pageSize: String(limit),
    fields: "files(id,name,modifiedTime,webViewLink)",
  });

  const res = await ctx.fetch(`/drive/v3/files?${params.toString()}`, {
    host: "www.googleapis.com",
  });
  if (!res.ok) {
    throw new Error(`GET /drive/v3/files ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as DriveFileList;
  return {
    spreadsheets: (data.files ?? []).map((file) => ({
      id: file.id ?? null,
      name: file.name ?? null,
      modifiedTime: file.modifiedTime ?? null,
      url: file.webViewLink ?? null,
    })),
  };
};
