type CommentBody = {
  parent?: { page_id: string };
  discussion_id?: string;
  rich_text: Array<{
    type: "text";
    text: { content: string };
  }>;
};

type CommentResponse = {
  id?: string;
  discussion_id?: string;
};

function pageIdFromInput(value: string): string {
  const trimmed = value.trim();
  const withoutQueryOrFragment = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const trailingId = withoutQueryOrFragment.match(/([0-9a-fA-F]{32})$/);
  return trailingId?.[1] ?? trimmed;
}

export default async (input: Input, ctx: Context) => {
  const richText: CommentBody["rich_text"] = [
    {
      type: "text",
      text: { content: input.text },
    },
  ];

  const body: CommentBody = input.discussionId
    ? { discussion_id: input.discussionId, rich_text: richText }
    : { parent: { page_id: pageIdFromInput(input.pageId) }, rich_text: richText };

  const res = await ctx.fetch("/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Notion-Version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { commented: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`POST /v1/comments ${res.status}: ${await res.text()}`);
  }

  const comment = (await res.json()) as CommentResponse;
  return {
    commented: true,
    id: comment.id ?? null,
    discussionId: comment.discussion_id ?? input.discussionId ?? null,
  };
};
