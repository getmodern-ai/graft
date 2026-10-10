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
  let stored = false;

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
    stored = true;
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

  // A stored file is read by byte range, never whole: the proxy refuses an answer past its body
  // cap, and an excerpt of `maxCharacters` needs at most four bytes per character, plus three
  // for a UTF-8 byte-order mark the decoder drops. An export
  // cannot be ranged; Google caps one at 10 MB, under the proxy's default cap.
  const headers: Record<string, string> = stored
    ? { range: `bytes=0-${maxCharacters * 4 + 2}` }
    : {};
  const contentResponse = await ctx.fetch(contentPath, { host, method: "GET", headers });
  if (stored && contentResponse.status === 416) {
    // An empty file has no byte 0 to range over.
    return {
      id,
      name,
      mimeType,
      readable: true,
      exportedAs,
      content: "",
      truncated: false,
      reason: null,
    };
  }
  if (!contentResponse.ok) {
    throw new Error(`GET file content ${contentResponse.status}: ${await contentResponse.text()}`);
  }

  // A range cut short of the file decodes to more than `maxCharacters` UTF-16 units, so the
  // length alone says whether anything was left out.
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
