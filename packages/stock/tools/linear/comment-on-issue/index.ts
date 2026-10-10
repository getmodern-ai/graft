const QUERY =
  "mutation CommentOnIssue($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url body createdAt } } }";

type Comment = {
  id: string;
  url: string;
  body: string;
  createdAt: string;
};

type LinearResponse = {
  data?: {
    commentCreate?: {
      success: boolean;
      comment: Comment | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  const variables = {
    issueId: input.issueId,
    body: input.body,
  };

  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { commented: false, sent: variables };
  }

  const payload = (await res.json()) as LinearResponse;
  const firstError = payload.errors?.[0]?.message;

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${firstError ?? JSON.stringify(payload)}`);
  }
  if (firstError) {
    throw new Error(`Linear GraphQL error: ${firstError}`);
  }

  const result = payload.data?.commentCreate;
  if (!result?.success || !result.comment) {
    throw new Error("Linear did not create the comment");
  }

  return {
    commented: true,
    comment: {
      id: result.comment.id,
      url: result.comment.url,
      body: result.comment.body,
      createdAt: result.comment.createdAt,
    },
  };
};
