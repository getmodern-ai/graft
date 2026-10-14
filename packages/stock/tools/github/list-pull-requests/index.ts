type Pull = {
  number: number;
  title: string;
  state: string;
  draft?: boolean | null;
  user?: { login?: string } | null;
  head?: { ref?: string } | null;
  base?: { ref?: string } | null;
  labels?: Array<{ name?: string | null }>;
  requested_reviewers?: Array<{ login?: string }> | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  html_url: string;
};

export default async (input: Input, ctx: Context) => {
  const params = new URLSearchParams({
    state: input.state ?? "open",
    sort: input.sort ?? "created",
    direction: input.direction ?? "desc",
    per_page: String(input.perPage ?? 30),
    page: String(input.page ?? 1),
  });
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const path = `/repos/${owner}/${repo}/pulls?${params.toString()}`;
  const res = await ctx.fetch(path, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
  const pulls = (await res.json()) as Pull[];
  return {
    pullRequests: pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      state: pull.state,
      draft: pull.draft ?? false,
      userLogin: pull.user?.login ?? null,
      headRef: pull.head?.ref ?? null,
      baseRef: pull.base?.ref ?? null,
      labels: (pull.labels ?? [])
        .map((label) => label.name)
        .filter((name): name is string => typeof name === "string"),
      requestedReviewers: (pull.requested_reviewers ?? [])
        .map((reviewer) => reviewer.login)
        .filter((login): login is string => typeof login === "string"),
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      mergedAt: pull.merged_at ?? null,
      htmlUrl: pull.html_url,
    })),
  };
};
