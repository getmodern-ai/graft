import { describe, expect, it } from "vitest";

/**
 * Notion's write tools and row query over inputs and answers their recordings do not hold (GRA-252,
 * Greptile on #207): a long line, an emoji at a split, a page URL naming a block, a relation Notion
 * cut short. The modules run themselves over a fake `ctx.fetch` that answers the dry run's preview,
 * imported by a computed path since `tools/` is outside this package's type program.
 */
const moduleOf = (name: string) =>
  new URL(`../tools/notion/${name}/index.ts`, import.meta.url).href;

type Sent = { path: string; init: { method?: string; body?: string } };

async function run(name: string, input: Record<string, unknown>, answer?: unknown) {
  const { default: tool } = (await import(/* @vite-ignore */ moduleOf(name))) as {
    default: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const sent: Sent[] = [];
  const ctx = {
    fetch: async (path: string, init: Sent["init"] = {}) => {
      sent.push({ path, init });
      if (answer !== undefined) return Response.json(answer);
      return new Response("{}", { status: 202, headers: { "x-graft-dry-run": "intercepted" } });
    },
  };
  return { result: await tool(input, ctx), sent };
}

type Block = Record<string, { rich_text: { text: { content: string } }[] }>;

describe("notion's page writers split a long line across text objects", () => {
  it.each(["create-page", "append-to-page"])("%s keeps every character", async (name) => {
    const line = `${"a".repeat(3999)}😀${"b".repeat(10)}`;
    const input =
      name === "create-page"
        ? { parentPageId: "0e6d0b52-d7e8-56eb-6621-d498a00dbb79", title: "T", content: line }
        : { pageId: "0e6d0b52-d7e8-56eb-6621-d498a00dbb79", content: line };
    const { sent } = await run(name, input);
    const body = JSON.parse(sent[0]?.init.body ?? "{}") as { children: Block[] };
    const texts = body.children[0]?.paragraph?.rich_text.map((part) => part.text.content) ?? [];
    expect(texts.join("")).toBe(line);
    expect(texts.every((text) => text.length <= 2000)).toBe(true);
    // No text object ends on half an emoji.
    expect(texts.every((text) => !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
  });

  it.each(["create-page", "append-to-page"])(
    "%s refuses a line past 100 text objects",
    async (name) => {
      const line = "a".repeat(200_001);
      const input =
        name === "create-page"
          ? { parentPageId: "0e6d0b52-d7e8-56eb-6621-d498a00dbb79", title: "T", content: line }
          : { pageId: "0e6d0b52-d7e8-56eb-6621-d498a00dbb79", content: line };
      await expect(run(name, input)).rejects.toThrow("at most 200000 characters");
    },
  );
});

describe("notion__append-to-page", () => {
  it("appends to the page a URL names, not a block in its fragment or a view in its query", async () => {
    const page = "1234567890abcdef1234567890abcdef";
    const block = "fedcba0987654321fedcba0987654321";
    const { sent } = await run("append-to-page", {
      pageId: `https://www.notion.so/Plans-${page}?v=${block}#${block}`,
      content: "hello",
    });
    expect(sent[0]?.path).toBe(`/blocks/${page}/children`);
  });
});

describe("notion__query-database", () => {
  it("names a relation Notion cut short, and adds nothing to a whole row", async () => {
    const { result } = await run(
      "query-database",
      { dataSourceId: "06a949d4-0ec8-5e99-c1d1-282edfe67566" },
      {
        results: [
          {
            id: "row-1",
            properties: {
              Tasks: { type: "relation", relation: [{ id: "t1" }], has_more: true },
              Parent: { type: "relation", relation: [], has_more: false },
            },
          },
          { id: "row-2", properties: { Parent: { type: "relation", relation: [] } } },
        ],
        next_cursor: null,
      },
    );
    const rows = result.rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      properties: { Tasks: ["t1"], Parent: [] },
      incompleteRelations: ["Tasks"],
    });
    expect(rows[1]).not.toHaveProperty("incompleteRelations");
  });
});
