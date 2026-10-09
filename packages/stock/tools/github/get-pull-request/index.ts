type GitHubUser = { login?: string };
type GitHubLabel = { name?: string };
type GitHubRef = { ref?: string };
type PullRequest = {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable_state?: string;
  body?: string | null;
  user?: GitHubUser | null;
  head?: GitHubRef;
  base?: GitHubRef;
  labels?: GitHubLabel[];
  requested_reviewers?: GitHubUser[];
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  html_url?: string;
};
type PullRequestFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
};

const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2026-03-10",
};

export default async (input: Input, ctx: Context) => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const pullNumber = input.pullNumber;
  const pullPath = `/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const filesPath = `${pullPath}/files?per_page=100`;

  // One read after the other: the recording's replay matches reads in order (RECORDING.md).
  const pullResponse = await ctx.fetch(pullPath, { headers });
  if (!pullResponse.ok) {
    throw new Error(`GET ${pullPath} ${pullResponse.status}: ${await pullResponse.text()}`);
  }
  const filesResponse = await ctx.fetch(filesPath, { headers });
  if (!filesResponse.ok) {
    throw new Error(`GET ${filesPath} ${filesResponse.status}: ${await filesResponse.text()}`);
  }

  const pull = (await pullResponse.json()) as PullRequest;
  const files = (await filesResponse.json()) as PullRequestFile[];

  return {
    number: pull.number ?? null,
    title: pull.title ?? null,
    state: pull.state ?? null,
    draft: pull.draft ?? null,
    merged: pull.merged ?? null,
    mergeable_state: pull.mergeable_state ?? null,
    body: pull.body ?? null,
    user: pull.user?.login ?? null,
    head: pull.head?.ref ?? null,
    base: pull.base?.ref ?? null,
    labels: (pull.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => typeof name === "string"),
    requested_reviewers: (pull.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => typeof login === "string"),
    commits: pull.commits ?? null,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    changed_files: pull.changed_files ?? null,
    created_at: pull.created_at ?? null,
    updated_at: pull.updated_at ?? null,
    merged_at: pull.merged_at ?? null,
    html_url: pull.html_url ?? null,
    files: files.map((file) => ({
      filename: file.filename ?? null,
      status: file.status ?? null,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      changes: file.changes ?? null,
    })),
  };
};
