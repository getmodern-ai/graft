type RichText = {
  type: "text";
  text: { content: string };
};

type TextBlock = {
  object: "block";
  type:
    | "heading_1"
    | "heading_2"
    | "heading_3"
    | "bulleted_list_item"
    | "numbered_list_item"
    | "quote"
    | "paragraph";
  heading_1?: { rich_text: RichText[] };
  heading_2?: { rich_text: RichText[] };
  heading_3?: { rich_text: RichText[] };
  bulleted_list_item?: { rich_text: RichText[] };
  numbered_list_item?: { rich_text: RichText[] };
  quote?: { rich_text: RichText[] };
  paragraph?: { rich_text: RichText[] };
};

type TodoBlock = {
  object: "block";
  type: "to_do";
  to_do: { rich_text: RichText[]; checked: boolean };
};

type Block = TextBlock | TodoBlock;

type AppendResponse = {
  results?: Array<{ id?: unknown }>;
};

function pageIdFrom(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const matches = trimmed.match(
    /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  );
  if (!matches?.length) throw new Error("The Notion page URL does not contain a page ID");
  return matches[matches.length - 1];
}

function richText(content: string): RichText[] {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

function textBlock(type: TextBlock["type"], content: string): TextBlock {
  return {
    object: "block",
    type,
    [type]: { rich_text: richText(content) },
  } as TextBlock;
}

function lineToBlock(line: string): Block {
  if (line.startsWith("### ")) return textBlock("heading_3", line.slice(4));
  if (line.startsWith("## ")) return textBlock("heading_2", line.slice(3));
  if (line.startsWith("# ")) return textBlock("heading_1", line.slice(2));
  if (line.startsWith("- ")) return textBlock("bulleted_list_item", line.slice(2));
  if (line.startsWith("1. ")) return textBlock("numbered_list_item", line.slice(3));
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
  if (line.startsWith("> ")) return textBlock("quote", line.slice(2));
  return textBlock("paragraph", line);
}

export default async (input: Input, ctx: Context) => {
  const lines = input.content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) throw new Error("Content must contain at least one non-empty line");
  if (lines.length > 100) throw new Error("Content must not contain more than 100 non-empty lines");

  const children = lines.map(lineToBlock);
  const body = { children };
  const pageId = pageIdFrom(input.pageId);
  const res = await ctx.fetch(`/blocks/${encodeURIComponent(pageId)}/children`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "Notion-Version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { appended: false, sent: body };
  }

  if (!res.ok)
    throw new Error(`PATCH /blocks/{page_id}/children ${res.status}: ${await res.text()}`);

  const response = (await res.json()) as AppendResponse;
  const blockIds = (response.results ?? [])
    .map((block) => block.id)
    .filter((id): id is string => typeof id === "string");

  return { appended: true, blockIds };
};
