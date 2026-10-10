type GitHubUser = { login?: string | null };
type GitHubLabel = { name?: string | null } | string;
type GitHubIssue = {
  number?: number;
  title?: string;
  state?: string;
  body?: string | null;
  user?: GitHubUser | null;
  labels?: GitHubLabel[];
  assignees?: GitHubUser[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  html_url?: string;
  pull_request?: unknown;
};
type GitHubComment = {
  id?: number;
  user?: GitHubUser | null;
  body?: string | null;
  created_at?: string;
  html_url?: string;
};

export default async (input: Input, ctx: Context) => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const issueNumber = input.issueNumber;
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };

  const issuePath = `/repos/${owner}/${repo}/issues/${issueNumber}`;
  const issueResponse = await ctx.fetch(issuePath, { headers });
  if (!issueResponse.ok) {
    throw new Error(`GET ${issuePath} ${issueResponse.status}: ${await issueResponse.text()}`);
  }
  const issue = (await issueResponse.json()) as GitHubIssue;

  const commentsPath = `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const commentsResponse = await ctx.fetch(commentsPath, { headers });
  if (!commentsResponse.ok) {
    throw new Error(
      `GET ${commentsPath} ${commentsResponse.status}: ${await commentsResponse.text()}`,
    );
  }
  const comments = (await commentsResponse.json()) as GitHubComment[];

  return {
    number: issue.number ?? issueNumber,
    title: issue.title ?? null,
    state: issue.state ?? null,
    body: issue.body ?? null,
    user: issue.user?.login ?? null,
    labels: (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : (label.name ?? null),
    ),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.login ?? null),
    created_at: issue.created_at ?? null,
    updated_at: issue.updated_at ?? null,
    closed_at: issue.closed_at ?? null,
    html_url: issue.html_url ?? null,
    is_pull_request: issue.pull_request !== undefined,
    comments: comments.map((comment) => ({
      id: comment.id ?? null,
      user: comment.user?.login ?? null,
      body: comment.body ?? null,
      created_at: comment.created_at ?? null,
      html_url: comment.html_url ?? null,
    })),
  };
};
