type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function textValue(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => objectValue(part)?.plain_text)
    .filter((part): part is string => typeof part === "string")
    .join("");
}

function dateValue(value: unknown): unknown {
  const date = objectValue(value);
  if (!date || typeof date.start !== "string") return null;
  return typeof date.end === "string" ? { start: date.start, end: date.end } : date.start;
}

function formulaValue(value: unknown): unknown {
  const formula = objectValue(value);
  if (!formula || typeof formula.type !== "string") return null;

  if (formula.type === "string") {
    return typeof formula.string === "string" ? formula.string : null;
  }
  if (formula.type === "number") {
    return typeof formula.number === "number" ? formula.number : null;
  }
  if (formula.type === "boolean") {
    return typeof formula.boolean === "boolean" ? formula.boolean : null;
  }
  if (formula.type === "date") return dateValue(formula.date);
  return null;
}

function propertyValue(value: unknown): unknown {
  const property = objectValue(value);
  if (!property || typeof property.type !== "string") return null;

  switch (property.type) {
    case "title":
      return textValue(property.title);
    case "rich_text":
      return textValue(property.rich_text);
    case "number":
      return typeof property.number === "number" ? property.number : null;
    case "select": {
      const option = objectValue(property.select);
      return typeof option?.name === "string" ? option.name : null;
    }
    case "status": {
      const option = objectValue(property.status);
      return typeof option?.name === "string" ? option.name : null;
    }
    case "multi_select":
      return Array.isArray(property.multi_select)
        ? property.multi_select
            .map((option) => objectValue(option)?.name)
            .filter((name): name is string => typeof name === "string")
        : [];
    case "date":
      return dateValue(property.date);
    case "checkbox":
      return typeof property.checkbox === "boolean" ? property.checkbox : null;
    case "url":
      return typeof property.url === "string" ? property.url : null;
    case "email":
      return typeof property.email === "string" ? property.email : null;
    case "phone_number":
      return typeof property.phone_number === "string" ? property.phone_number : null;
    case "people":
      return Array.isArray(property.people)
        ? property.people
            .map((person) => objectValue(person)?.name)
            .filter((name): name is string => typeof name === "string")
        : [];
    case "relation":
      return Array.isArray(property.relation)
        ? property.relation
            .map((relation) => objectValue(relation)?.id)
            .filter((id): id is string => typeof id === "string")
        : [];
    case "formula":
      return formulaValue(property.formula);
    case "rollup": {
      const rollup = objectValue(property.rollup);
      if (!rollup || typeof rollup.type !== "string") return null;
      if (rollup.type === "number") {
        return typeof rollup.number === "number" ? rollup.number : null;
      }
      if (rollup.type === "date") return dateValue(rollup.date);
      if (rollup.type === "array" && Array.isArray(rollup.array)) {
        return rollup.array.map((item) => propertyValue(item));
      }
      return null;
    }
    default:
      return null;
  }
}

function flattenProperties(value: unknown): Record<string, unknown> {
  const properties = objectValue(value);
  if (!properties) return {};
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [name, propertyValue(property)]),
  );
}

export default async (input: Input, ctx: Context) => {
  const body: JsonObject = {
    page_size: input.pageSize ?? 20,
  };
  if (input.filter !== undefined) body.filter = input.filter;
  if (input.sorts !== undefined) body.sorts = input.sorts;
  if (input.startCursor !== undefined) body.start_cursor = input.startCursor;

  const path = `/v1/data_sources/${encodeURIComponent(input.dataSourceId)}/query`;
  const res = await ctx.fetch(path, {
    host: "api.notion.com",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "notion-version": "2025-09-03",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }

  const response = objectValue(await res.json());
  if (!response || !Array.isArray(response.results)) {
    throw new Error(`POST ${path} ${res.status}: Notion returned an invalid list response`);
  }

  const rows = response.results.map((item) => {
    const row = objectValue(item);
    return {
      id: typeof row?.id === "string" ? row.id : null,
      url: typeof row?.url === "string" ? row.url : null,
      last_edited_time: typeof row?.last_edited_time === "string" ? row.last_edited_time : null,
      properties: flattenProperties(row?.properties),
    };
  });

  return {
    rows,
    nextCursor: typeof response.next_cursor === "string" ? response.next_cursor : null,
  };
};
