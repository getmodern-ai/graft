type IssueResponse = {
  number: number;
  title: string;
  state: string;
  state_reason: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  html_url: string;
};

export default async (input: Input, ctx: Context) => {
  const sent: Record<string, unknown> = {};
  if (input.state !== undefined) sent.state = input.state;
  if (input.stateReason !== undefined) sent.state_reason = input.stateReason;
  if (input.title !== undefined) sent.title = input.title;
  if (input.body !== undefined) sent.body = input.body;
  if (input.labels !== undefined) sent.labels = input.labels;
  if (input.assignees !== undefined) sent.assignees = input.assignees;

  if (Object.keys(sent).length === 0) {
    throw new Error(
      "At least one field to change is required: state, stateReason, title, body, labels, or assignees.",
    );
  }

  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}`;
  const res = await ctx.fetch(path, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(sent),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent };
  }
  if (!res.ok) throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);

  const issue = (await res.json()) as IssueResponse;
  return {
    updated: true,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    state_reason: issue.state_reason,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
    html_url: issue.html_url,
  };
};
