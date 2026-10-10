type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function parsePageId(value: string): string {
  const trimmed = value.trim();
  const withoutQuery = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const match = withoutQuery.match(
    /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (!match) {
    throw new Error("pageId must be a Notion page ID or a page URL ending in a page ID");
  }
  const compact = match[1].replace(/-/g, "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function plainText(value: unknown): string {
  const object = asObject(value);
  const richText = object?.rich_text;
  if (!Array.isArray(richText)) return "";
  return richText
    .map((item) => {
      const rich = asObject(item);
      return typeof rich?.plain_text === "string" ? rich.plain_text : "";
    })
    .join("");
}

function pageTitle(page: JsonObject): string {
  const properties = asObject(page.properties);
  if (!properties) return "";
  for (const value of Object.values(properties)) {
    const property = asObject(value);
    if (property?.type !== "title" || !Array.isArray(property.title)) continue;
    return property.title
      .map((item) => {
        const rich = asObject(item);
        return typeof rich?.plain_text === "string" ? rich.plain_text : "";
      })
      .join("");
  }
  return "";
}

function renderBlock(value: unknown): string {
  const block = asObject(value);
  if (!block || typeof block.type !== "string") return "[unsupported]";
  const type = block.type;
  const payload = asObject(block[type]);

  if (type === "child_page" || type === "child_database") {
    const title = typeof payload?.title === "string" ? payload.title : "";
    return `[${title}]`;
  }

  const text = plainText(payload);
  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `${payload?.checked === true ? "[x]" : "[ ]"} ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    default:
      return `[${type}]`;
  }
}

export default async (input: Input, ctx: Context) => {
  const requestedPageId = parsePageId(input.pageId);
  const maxPages = input.maxPages ?? 5;
  const headers = { "Notion-Version": "2025-09-03" };

  const pageResponse = await ctx.fetch(`/pages/${encodeURIComponent(requestedPageId)}`, {
    headers,
  });
  if (!pageResponse.ok) {
    throw new Error(`GET /pages/{page_id} ${pageResponse.status}: ${await pageResponse.text()}`);
  }
  const pageValue: unknown = await pageResponse.json();
  const page = asObject(pageValue);
  if (!page) throw new Error("Notion returned an invalid page response");

  const lines: string[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  for (let pageNumber = 0; pageNumber < maxPages && hasMore; pageNumber += 1) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const path = `/blocks/${encodeURIComponent(requestedPageId)}/children?${query.toString()}`;
    const childrenResponse = await ctx.fetch(path, { headers });
    if (!childrenResponse.ok) {
      throw new Error(
        `GET /blocks/{page_id}/children ${childrenResponse.status}: ${await childrenResponse.text()}`,
      );
    }
    const childrenValue: unknown = await childrenResponse.json();
    const children = asObject(childrenValue);
    if (!children || !Array.isArray(children.results)) {
      throw new Error("Notion returned an invalid block children response");
    }
    lines.push(...children.results.map(renderBlock));
    hasMore = children.has_more === true;
    cursor = typeof children.next_cursor === "string" ? children.next_cursor : null;
    if (hasMore && !cursor) {
      throw new Error("Notion reported more blocks without a next cursor");
    }
  }

  return {
    pageId: typeof page.id === "string" ? page.id : requestedPageId,
    title: pageTitle(page),
    url: typeof page.url === "string" ? page.url : "",
    text: lines.join("\n"),
    complete: !hasMore,
  };
};
