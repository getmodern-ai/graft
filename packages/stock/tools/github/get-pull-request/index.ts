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

// GitHub answers at most 3,000 changed files, 100 to a page.
const MAX_FILE_PAGES = 30;

const hasNextPage = (link: string | null): boolean =>
  (link ?? "").split(",").some((member) => {
    const rel = /;\s*rel="?([^";]*)"?/i.exec(member)?.[1] ?? "";
    return rel.split(/\s+/).includes("next");
  });

export default async (input: Input, ctx: Context) => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const pullNumber = input.pullNumber;
  const pullPath = `/repos/${owner}/${repo}/pulls/${pullNumber}`;

  // One read after the other: the recording's replay matches reads in order (RECORDING.md).
  const pullResponse = await ctx.fetch(pullPath, { headers });
  if (!pullResponse.ok) {
    throw new Error(`GET ${pullPath} ${pullResponse.status}: ${await pullResponse.text()}`);
  }
  const pull = (await pullResponse.json()) as PullRequest;

  // Every page of the changed files, while GitHub's `link` header names a next one, up to the
  // 3,000 files the endpoint answers at most.
  const files: PullRequestFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const filesPath = `${pullPath}/files?per_page=100${page > 1 ? `&page=${page}` : ""}`;
    const filesResponse = await ctx.fetch(filesPath, { headers });
    if (!filesResponse.ok) {
      throw new Error(`GET ${filesPath} ${filesResponse.status}: ${await filesResponse.text()}`);
    }
    const pageFiles: unknown = await filesResponse.json();
    if (!Array.isArray(pageFiles)) {
      throw new Error(`GET ${filesPath} returned a non-array response`);
    }
    files.push(...(pageFiles as PullRequestFile[]));
    if (!hasNextPage(filesResponse.headers.get("link"))) break;
  }

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
