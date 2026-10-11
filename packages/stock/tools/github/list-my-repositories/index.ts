type Repository = {
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  open_issues_count: number;
  updated_at: string;
  html_url: string;
};

export default async (input: Input, ctx: Context) => {
  const perPage = input.perPage ?? 30;
  const page = input.page ?? 1;
  const path = `/user/repos?sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
  const res = await ctx.fetch(path, {
    headers: { accept: "application/vnd.github+json" },
  });

  if (!res.ok) {
    throw new Error(`GET /user/repos ${res.status}: ${await res.text()}`);
  }

  const repositories = (await res.json()) as Repository[];
  return {
    repositories: repositories.map((repository) => ({
      full_name: repository.full_name,
      description: repository.description,
      private: repository.private,
      default_branch: repository.default_branch,
      language: repository.language,
      stargazers_count: repository.stargazers_count,
      open_issues_count: repository.open_issues_count,
      updated_at: repository.updated_at,
      html_url: repository.html_url,
    })),
  };
};
