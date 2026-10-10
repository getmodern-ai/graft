type SearchLabel = {
  name?: string | null;
};

type SearchItem = {
  repository_url?: string;
  number?: number;
  title?: string;
  state?: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
  labels?: SearchLabel[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
};

type SearchResponse = {
  total_count?: number;
  incomplete_results?: boolean;
  items?: SearchItem[];
};

function repositoryName(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null;
  const marker = "/repos/";
  const markerIndex = repositoryUrl.indexOf(marker);
  return markerIndex >= 0 ? repositoryUrl.slice(markerIndex + marker.length) : null;
}

export default async (input: Input, ctx: Context) => {
  const params = new URLSearchParams({
    q: input.q,
    order: input.order ?? "desc",
    per_page: String(input.perPage ?? 30),
    page: String(input.page ?? 1),
  });
  if (input.sort) params.set("sort", input.sort);

  const path = `/search/issues?${params.toString()}`;
  const res = await ctx.fetch(path, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET /search/issues ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as SearchResponse;
  return {
    total_count: data.total_count ?? 0,
    incomplete_results: data.incomplete_results ?? false,
    items: (data.items ?? []).map((item) => ({
      repository: repositoryName(item.repository_url),
      number: item.number ?? null,
      title: item.title ?? null,
      state: item.state ?? null,
      is_pull_request: item.pull_request !== undefined,
      user_login: item.user?.login ?? null,
      labels: (item.labels ?? []).flatMap((label) =>
        typeof label.name === "string" ? [label.name] : [],
      ),
      comments: item.comments ?? 0,
      created_at: item.created_at ?? null,
      updated_at: item.updated_at ?? null,
      html_url: item.html_url ?? null,
    })),
  };
};
