type MailFolder = {
  id: string;
  displayName: string;
  parentFolderId: string;
  totalItemCount: number;
  unreadItemCount: number;
};

type MailFolderPage = {
  value?: unknown;
  "@odata.nextLink"?: unknown;
};

export default async (input: Input, ctx: Context) => {
  const folders: MailFolder[] = [];
  let next: string | null = input.includeHidden
    ? "/me/mailFolders?$top=100&includeHiddenFolders=true"
    : "/me/mailFolders?$top=100";

  for (let pageNumber = 0; pageNumber < 5 && next; pageNumber += 1) {
    const res = await ctx.fetch(next);
    if (!res.ok) {
      throw new Error(`GET mail folders page ${pageNumber + 1} ${res.status}: ${await res.text()}`);
    }

    const page = (await res.json()) as MailFolderPage;
    if (!Array.isArray(page.value)) {
      throw new Error(
        `GET mail folders page ${pageNumber + 1}: response did not contain a folder collection`,
      );
    }

    for (const item of page.value) {
      if (typeof item !== "object" || item === null) {
        throw new Error(
          `GET mail folders page ${pageNumber + 1}: response contained an invalid folder`,
        );
      }
      const folder = item as Record<string, unknown>;
      if (
        typeof folder.id !== "string" ||
        typeof folder.displayName !== "string" ||
        typeof folder.parentFolderId !== "string" ||
        typeof folder.totalItemCount !== "number" ||
        typeof folder.unreadItemCount !== "number"
      ) {
        throw new Error(
          `GET mail folders page ${pageNumber + 1}: a folder was missing required fields`,
        );
      }
      folders.push({
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        totalItemCount: folder.totalItemCount,
        unreadItemCount: folder.unreadItemCount,
      });
    }

    const nextLink = page["@odata.nextLink"];
    next = typeof nextLink === "string" ? nextLink : null;
  }

  return { folders };
};
