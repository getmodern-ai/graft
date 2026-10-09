type DriveOwner = {
  displayName?: string;
  emailAddress?: string;
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  owners?: DriveOwner[];
  shared?: boolean;
  starred?: boolean;
  trashed?: boolean;
};

const fields =
  "id,name,mimeType,description,createdTime,modifiedTime,size,parents,webViewLink,owners(displayName,emailAddress),shared,starred,trashed";

export default async (input: Input, ctx: Context) => {
  const path = `/drive/v3/files/${encodeURIComponent(input.fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  const res = await ctx.fetch(path, { host: "www.googleapis.com" });
  if (!res.ok) {
    throw new Error(`GET /drive/v3/files/{fileId} ${res.status}: ${await res.text()}`);
  }

  const file = (await res.json()) as DriveFile;
  return {
    id: file.id ?? null,
    name: file.name ?? null,
    mimeType: file.mimeType ?? null,
    description: file.description ?? null,
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
    size: file.size ?? null,
    parents: file.parents ?? null,
    webViewLink: file.webViewLink ?? null,
    owners:
      file.owners?.map((owner) => ({
        displayName: owner.displayName ?? null,
        emailAddress: owner.emailAddress ?? null,
      })) ?? null,
    shared: file.shared ?? null,
    starred: file.starred ?? null,
    trashed: file.trashed ?? null,
  };
};
