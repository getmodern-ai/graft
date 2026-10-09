export default async (input: Input, ctx: Context) => {
  if (input.folderId === undefined && input.newName === undefined) {
    throw new Error("Provide at least one of folderId or newName.");
  }

  const fileId = encodeURIComponent(input.fileId);
  let parents: string[] = [];

  if (input.folderId !== undefined) {
    const getRes = await ctx.fetch(
      `/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`,
      { host: "www.googleapis.com" },
    );
    if (!getRes.ok) {
      throw new Error(`GET /drive/v3/files/{fileId} ${getRes.status}: ${await getRes.text()}`);
    }
    const current = (await getRes.json()) as { parents?: unknown };
    if (Array.isArray(current.parents)) {
      parents = current.parents.filter((parent): parent is string => typeof parent === "string");
    }
  }

  const query = new URLSearchParams();
  if (input.folderId !== undefined) {
    query.set("addParents", input.folderId);
    query.set("removeParents", parents.join(","));
  }
  query.set("supportsAllDrives", "true");
  query.set("fields", "id,name,parents,webViewLink");

  const body = input.newName === undefined ? {} : { name: input.newName };
  const patchRes = await ctx.fetch(`/drive/v3/files/${fileId}?${query.toString()}`, {
    host: "www.googleapis.com",
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!patchRes.ok) {
    throw new Error(`PATCH /drive/v3/files/{fileId} ${patchRes.status}: ${await patchRes.text()}`);
  }

  const updated = (await patchRes.json()) as {
    id?: unknown;
    name?: unknown;
    parents?: unknown;
    webViewLink?: unknown;
  };
  return {
    id: typeof updated.id === "string" ? updated.id : null,
    name: typeof updated.name === "string" ? updated.name : null,
    parents: Array.isArray(updated.parents)
      ? updated.parents.filter((parent): parent is string => typeof parent === "string")
      : null,
    webViewLink: typeof updated.webViewLink === "string" ? updated.webViewLink : null,
  };
};
