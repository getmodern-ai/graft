type DirectoryEntry = {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  size?: unknown;
};

type FileContent = {
  type?: unknown;
  path?: unknown;
  name?: unknown;
  sha?: unknown;
  size?: unknown;
  encoding?: unknown;
  content?: unknown;
  html_url?: unknown;
};

export default async (input: Input, ctx: Context) => {
  const path = input.path ?? "README.md";
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const query = input.ref === undefined ? "" : `?ref=${encodeURIComponent(input.ref)}`;
  const endpoint = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodedPath}${query}`;

  const res = await ctx.fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GET repository content ${res.status}: ${await res.text()}`);
  }

  const data: unknown = await res.json();
  if (Array.isArray(data)) {
    return {
      type: "dir",
      entries: data.map((value: unknown) => {
        const entry = value as DirectoryEntry;
        return {
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
        };
      }),
    };
  }

  if (typeof data !== "object" || data === null || (data as FileContent).type !== "file") {
    throw new Error("GitHub returned repository content that is neither a file nor a directory");
  }

  const file = data as FileContent;
  const contentAvailable =
    file.encoding === "base64" &&
    typeof file.content === "string" &&
    (file.content.length > 0 || file.size === 0);

  return {
    type: "file",
    path: file.path,
    name: file.name,
    sha: file.sha,
    size: file.size,
    encoding: "utf-8",
    content: contentAvailable
      ? Buffer.from(file.content as string, "base64").toString("utf8")
      : null,
    truncated: !contentAvailable,
    html_url: file.html_url,
  };
};
