export default async (input: Input, ctx: Context) => {
  const payload: {
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  } = {
    title: input.title,
    head: input.head,
    base: input.base,
  };

  if (input.body !== undefined) payload.body = input.body;
  if (input.draft !== undefined) payload.draft = input.draft;

  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`;
  const res = await ctx.fetch(path, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: payload };
  }

  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const pull = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    draft: boolean;
    html_url: string;
  };

  return {
    created: true,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    html_url: pull.html_url,
  };
};
