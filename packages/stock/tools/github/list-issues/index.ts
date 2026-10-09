export default async (input: Input, ctx: Context) => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const query = new URLSearchParams({
    state: input.state ?? "open",
    per_page: String(input.perPage ?? 30),
    page: String(input.page ?? 1),
  });

  const res = await ctx.fetch(`/repos/${owner}/${repo}/issues?${query}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GET /repos/{owner}/{repo}/issues ${res.status}: ${await res.text()}`);
  }

  const items: unknown = await res.json();
  if (!Array.isArray(items)) {
    throw new Error("GET /repos/{owner}/{repo}/issues returned a non-array response");
  }

  return {
    issues: items
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !("pull_request" in item),
      )
      .map((issue) => {
        const user =
          typeof issue.user === "object" && issue.user !== null
            ? (issue.user as Record<string, unknown>)
            : null;
        const labels = Array.isArray(issue.labels) ? issue.labels : [];
        const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];

        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          user: typeof user?.login === "string" ? user.login : null,
          labels: labels.flatMap((label) => {
            if (typeof label === "string") return [label];
            if (typeof label === "object" && label !== null) {
              const name = (label as Record<string, unknown>).name;
              return typeof name === "string" ? [name] : [];
            }
            return [];
          }),
          assignees: assignees.flatMap((assignee) => {
            if (typeof assignee !== "object" || assignee === null) return [];
            const login = (assignee as Record<string, unknown>).login;
            return typeof login === "string" ? [login] : [];
          }),
          comments: issue.comments,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          html_url: issue.html_url,
        };
      }),
  };
};
