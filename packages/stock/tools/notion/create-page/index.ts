/** Notion's limits: 2,000 characters per text object, 100 text objects per block. */
const TEXT_LIMIT = 2000;
const TEXTS_PER_BLOCK = 100;

function richText(content: string) {
  if (content.length > TEXT_LIMIT * TEXTS_PER_BLOCK) {
    throw new Error(`A line may hold at most ${TEXT_LIMIT * TEXTS_PER_BLOCK} characters`);
  }
  const parts: { type: "text"; text: { content: string } }[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + TEXT_LIMIT, content.length);
    // Never between the two halves of a surrogate pair (an emoji): cut before it instead.
    const last = content.charCodeAt(end - 1);
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push({ type: "text", text: { content: content.slice(start, end) } });
    start = end;
  }
  if (parts.length > TEXTS_PER_BLOCK) {
    throw new Error(`A line may hold at most ${TEXT_LIMIT * TEXTS_PER_BLOCK} characters`);
  }
  return parts;
}

function blockForLine(line: string) {
  if (line.startsWith("### ")) {
    return {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: richText(line.slice(4)) },
    };
  }
  if (line.startsWith("## ")) {
    return {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText(line.slice(3)) },
    };
  }
  if (line.startsWith("# ")) {
    return {
      object: "block",
      type: "heading_1",
      heading_1: { rich_text: richText(line.slice(2)) },
    };
  }
  if (line.startsWith("[ ] ")) {
    return {
      object: "block",
      type: "to_do",
      to_do: { rich_text: richText(line.slice(4)), checked: false },
    };
  }
  if (line.startsWith("[x] ")) {
    return {
      object: "block",
      type: "to_do",
      to_do: { rich_text: richText(line.slice(4)), checked: true },
    };
  }
  if (line.startsWith("- ")) {
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText(line.slice(2)) },
    };
  }
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(line) } };
}

export default async (input: Input, ctx: Context) => {
  const hasPageParent = typeof input.parentPageId === "string";
  const hasDataSourceParent = typeof input.dataSourceId === "string";
  if (hasPageParent === hasDataSourceParent) {
    throw new Error("Exactly one of parentPageId or dataSourceId is required");
  }
  if (hasPageParent && (input.properties !== undefined || input.titleProperty !== undefined)) {
    throw new Error("properties and titleProperty can only be used with dataSourceId");
  }

  const titleValue = {
    type: "title",
    title: richText(input.title),
  };

  const body: Record<string, unknown> = hasPageParent
    ? {
        parent: { type: "page_id", page_id: input.parentPageId },
        properties: { title: titleValue },
      }
    : {
        parent: { type: "data_source_id", data_source_id: input.dataSourceId },
        properties: {
          ...(input.properties ?? {}),
          [input.titleProperty ?? "Name"]: titleValue,
        },
      };

  if (input.content !== undefined) {
    const lines = input.content.split(/\r\n|\n|\r/);
    if (lines.length > 100) throw new Error("content must contain at most 100 lines");
    body.children = lines.map(blockForLine);
  }

  const res = await ctx.fetch("/pages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Notion-Version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent: body };
  }
  if (!res.ok) throw new Error(`POST /v1/pages ${res.status}: ${await res.text()}`);

  const page = (await res.json()) as { id?: unknown; url?: unknown };
  if (typeof page.id !== "string" || typeof page.url !== "string") {
    throw new Error("POST /v1/pages returned no page id or URL");
  }
  return { created: true, id: page.id, url: page.url };
};
