type CreatedFolder = {
  id?: string;
  name?: string;
  parents?: string[];
  webViewLink?: string;
};

export default async (input: Input, ctx: Context) => {
  const body: { name: string; mimeType: string; parents?: string[] } = {
    name: input.name,
    mimeType: "application/vnd.google-apps.folder",
  };

  if (input.parentId !== undefined) {
    body.parents = [input.parentId];
  }

  const res = await ctx.fetch(
    "/drive/v3/files?supportsAllDrives=true&fields=id,name,parents,webViewLink",
    {
      host: "www.googleapis.com",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    throw new Error(`POST /drive/v3/files ${res.status}: ${await res.text()}`);
  }

  const folder = (await res.json()) as CreatedFolder;
  return {
    id: folder.id ?? null,
    name: folder.name ?? null,
    parents: folder.parents ?? null,
    webViewLink: folder.webViewLink ?? null,
  };
};
