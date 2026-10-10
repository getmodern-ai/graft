type RichText = {
  plain_text?: string;
};

type PageProperty = {
  type?: string;
  title?: RichText[];
};

type SearchItem = {
  object: string;
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, PageProperty>;
  title?: RichText[];
  parent?: {
    database_id?: string;
  };
};

type SearchResponse = {
  results?: SearchItem[];
  next_cursor?: string | null;
};

function plainText(parts: RichText[] | undefined): string {
  return (parts ?? []).map((part: RichText) => part.plain_text ?? "").join("");
}

export default async (input: Input, ctx: Context) => {
  const body: Record<string, unknown> = {
    page_size: input.pageSize ?? 20,
    sort: {
      timestamp: "last_edited_time",
      direction: "descending",
    },
  };

  if (input.query) body.query = input.query;
  if (input.startCursor) body.start_cursor = input.startCursor;
  if (input.filter) {
    body.filter = {
      property: "object",
      value: input.filter === "database" ? "data_source" : "page",
    };
  }

  // The host named, so the check reads this POST as the reviewed read it is (GRA-260).
  const res = await ctx.fetch("/v1/search", {
    host: "api.notion.com",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Notion-Version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /v1/search ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as SearchResponse;
  const results = (data.results ?? []).map((item: SearchItem) => {
    const pageTitle = Object.values(item.properties ?? {}).find(
      (property: PageProperty) => property.type === "title",
    )?.title;
    const title = plainText(item.object === "data_source" ? item.title : pageTitle);
    const common = {
      object: item.object,
      id: item.id,
      title,
      url: item.url ?? null,
      last_edited_time: item.last_edited_time ?? null,
    };

    if (item.object === "data_source") {
      return {
        ...common,
        database_id: item.parent?.database_id ?? null,
      };
    }
    return common;
  });

  return {
    results,
    nextCursor: data.next_cursor ?? null,
  };
};
