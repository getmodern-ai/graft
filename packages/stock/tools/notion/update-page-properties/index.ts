function normalizePageId(value: string): string {
  const trimmed = value.trim();
  const withoutQueryOrFragment = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const compactMatch = withoutQueryOrFragment.match(/([0-9a-f]{32})$/i);
  if (compactMatch) return compactMatch[1];

  const uuidMatch = withoutQueryOrFragment.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (uuidMatch) return uuidMatch[1];

  throw new Error("pageId must be a Notion page ID or a URL ending in a 32-hex-character page ID");
}

export default async (input: Input, ctx: Context) => {
  const pageId = normalizePageId(input.pageId);
  const properties = { ...input.properties };

  if (input.title !== undefined) {
    const titleProperty = input.titleProperty ?? "Name";
    properties[titleProperty] = {
      title: [{ type: "text", text: { content: input.title } }],
    };
  }
  if (Object.keys(properties).length === 0) {
    throw new Error("Give properties, a title, or both");
  }

  const body = { properties };
  const res = await ctx.fetch(`/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "Notion-Version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent: body };
  }

  if (!res.ok) {
    throw new Error(`PATCH /pages/{page_id} ${res.status}: ${await res.text()}`);
  }

  const page = (await res.json()) as { id?: string; url?: string };
  return { updated: true, id: page.id ?? null, url: page.url ?? null };
};
