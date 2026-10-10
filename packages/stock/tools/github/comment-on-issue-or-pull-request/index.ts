export default async (input: Input, ctx: Context) => {
  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const sent = {
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    body: input.body,
  };

  const res = await ctx.fetch(path, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body: input.body }),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent };
  }
  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const comment = (await res.json()) as {
    id?: number;
    html_url?: string;
    created_at?: string;
  };
  if (
    typeof comment.id !== "number" ||
    typeof comment.html_url !== "string" ||
    typeof comment.created_at !== "string"
  ) {
    throw new Error(`POST ${path} returned an invalid comment response`);
  }

  return {
    created: true,
    id: comment.id,
    html_url: comment.html_url,
    created_at: comment.created_at,
  };
};
