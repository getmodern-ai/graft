type MailFolder = {
  id: string;
  displayName: string;
  parentFolderId: string;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
};

type MailFolderPage = {
  value?: unknown;
  "@odata.nextLink"?: unknown;
};

type PageTask = {
  path: string;
  label: string;
};

export default async (input: Input, ctx: Context) => {
  const folders: MailFolder[] = [];
  const includeHidden = input.includeHidden === true;
  const queue: PageTask[] = [
    {
      path: includeHidden
        ? "/me/mailFolders?$top=100&includeHiddenFolders=true"
        : "/me/mailFolders?$top=100",
      label: "mail folders",
    },
  ];

  let reads = 0;

  while (queue.length > 0 && reads < 20) {
    const task = queue.shift();
    if (!task) break;

    reads += 1;
    const res = await ctx.fetch(task.path);
    if (!res.ok) {
      throw new Error(`GET ${task.label} ${res.status}: ${await res.text()}`);
    }

    const page = (await res.json()) as MailFolderPage;
    if (!Array.isArray(page.value)) {
      throw new Error(`GET ${task.label}: response did not contain a folder collection`);
    }

    const childTasks: PageTask[] = [];
    for (const item of page.value) {
      if (typeof item !== "object" || item === null) {
        throw new Error(`GET ${task.label}: response contained an invalid folder`);
      }

      const folder = item as Record<string, unknown>;
      if (
        typeof folder.id !== "string" ||
        typeof folder.displayName !== "string" ||
        typeof folder.parentFolderId !== "string" ||
        typeof folder.childFolderCount !== "number" ||
        typeof folder.totalItemCount !== "number" ||
        typeof folder.unreadItemCount !== "number"
      ) {
        throw new Error(`GET ${task.label}: a folder was missing required fields`);
      }

      folders.push({
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        childFolderCount: folder.childFolderCount,
        totalItemCount: folder.totalItemCount,
        unreadItemCount: folder.unreadItemCount,
      });

      if (folder.childFolderCount > 0) {
        const folderId = encodeURIComponent(folder.id);
        childTasks.push({
          path: includeHidden
            ? `/me/mailFolders/${folderId}/childFolders?$top=100&includeHiddenFolders=true`
            : `/me/mailFolders/${folderId}/childFolders?$top=100`,
          label: `child folders of ${folder.id}`,
        });
      }
    }

    const nextLink = page["@odata.nextLink"];
    queue.push(...childTasks);
    if (typeof nextLink === "string") {
      queue.unshift({ path: nextLink, label: `${task.label} next page` });
    }
  }

  return { folders, complete: queue.length === 0 };
};
