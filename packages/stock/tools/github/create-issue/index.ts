export default async (input: Input, ctx: Context) => {
  const issue: {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  } = { title: input.title };

  if (input.body !== undefined) issue.body = input.body;
  if (input.labels !== undefined) issue.labels = input.labels;
  if (input.assignees !== undefined) issue.assignees = input.assignees;

  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
  const res = await ctx.fetch(path, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify(issue),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: issue };
  }

  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const created = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    html_url: string;
  };

  return {
    created: true,
    number: created.number,
    title: created.title,
    state: created.state,
    html_url: created.html_url,
  };
};
