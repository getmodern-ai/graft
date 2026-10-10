function richText(content: string) {
  if (content.length === 0) return [];
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
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
