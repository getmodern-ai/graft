type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
};

export default async (input: Input, ctx: Context) => {
  const fileId = encodeURIComponent(input.fileId);
  const maxCharacters = input.maxCharacters ?? 20000;
  const host = "www.googleapis.com";

  const metadataPath = `/drive/v3/files/${fileId}?fields=id%2Cname%2CmimeType%2Csize&supportsAllDrives=true`;
  const metadataResponse = await ctx.fetch(metadataPath, { host });
  if (!metadataResponse.ok) {
    throw new Error(
      `GET file metadata ${metadataResponse.status}: ${await metadataResponse.text()}`,
    );
  }

  const file = (await metadataResponse.json()) as DriveFile;
  const id = file.id ?? input.fileId;
  const name = file.name ?? "";
  const mimeType = file.mimeType ?? "";

  let contentPath: string | null = null;
  let exportedAs: string | null = null;

  if (
    mimeType === "application/vnd.google-apps.document" ||
    mimeType === "application/vnd.google-apps.presentation"
  ) {
    exportedAs = "text/plain";
    contentPath = `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportedAs)}`;
  } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
    exportedAs = "text/csv";
    contentPath = `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportedAs)}`;
  } else if (mimeType.startsWith("application/vnd.google-apps.")) {
    return {
      id,
      name,
      mimeType,
      readable: false,
      exportedAs: null,
      content: "",
      truncated: false,
      reason: `Google Workspace file type ${mimeType} cannot be read as text.`,
    };
  } else if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/csv"
  ) {
    exportedAs = mimeType;
    contentPath = `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  } else {
    return {
      id,
      name,
      mimeType,
      readable: false,
      exportedAs: null,
      content: "",
      truncated: false,
      reason: `File type ${mimeType || "unknown"} is not supported as text.`,
    };
  }

  const contentResponse = await ctx.fetch(contentPath, { host });
  if (!contentResponse.ok) {
    throw new Error(`GET file content ${contentResponse.status}: ${await contentResponse.text()}`);
  }

  const fullContent = await contentResponse.text();
  const truncated = fullContent.length > maxCharacters;

  return {
    id,
    name,
    mimeType,
    readable: true,
    exportedAs,
    content: truncated ? fullContent.slice(0, maxCharacters) : fullContent,
    truncated,
    reason: null,
  };
};
