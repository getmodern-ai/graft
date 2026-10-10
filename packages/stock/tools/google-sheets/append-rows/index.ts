type Cell = string | number | boolean | null;
type ObjectRow = Record<string, Cell>;
type HeaderResponse = { values?: unknown[][] };
type AppendResponse = {
  updates?: {
    updatedRange?: unknown;
    updatedRows?: unknown;
  };
};

function spreadsheetId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/d\/([^/]+)/);
  const id = match ? match[1] : trimmed;
  if (!id) throw new Error("Spreadsheet ID is empty");
  return id;
}

function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  }
  return letters;
}

/**
 * The keys google-sheets__read-rows answers, each with its column's index: a blank header is
 * `column_<letter>` and a repeated one takes `_2`, `_3`.
 */
function columnKeys(headerCells: unknown[]): Map<string, number> {
  const keys = new Map<string, number>();
  for (let index = 0; index < headerCells.length; index += 1) {
    const text = String(headerCells[index] ?? "").trim();
    const base = text || `column_${columnLetter(index)}`;
    let key = base;
    for (let suffix = 2; keys.has(key); suffix += 1) key = `${base}_${suffix}`;
    keys.set(key, index);
  }
  return keys;
}

/** A key's column: a header key, or `column_<letter>` for a column past the header, A to Z. */
function columnOf(keys: Map<string, number>, key: string): number | null {
  const known = keys.get(key);
  if (known !== undefined) return known;
  const match = key.match(/^column_([A-Z])$/);
  return match ? match[1].charCodeAt(0) - 65 : null;
}

function quotedTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

export default async (input: Input, ctx: Context) => {
  const id = spreadsheetId(input.spreadsheet);
  const tab = quotedTab(input.tab);
  const hasObjectRows = input.rows.some((row) => !Array.isArray(row));
  let headerCells: unknown[] = [];

  if (hasObjectRows) {
    const headerRange = encodeURIComponent(`${tab}!1:1`);
    const headerRes = await ctx.fetch(
      `/v4/spreadsheets/${encodeURIComponent(id)}/values/${headerRange}`,
      { host: "sheets.googleapis.com" },
    );
    if (!headerRes.ok) {
      throw new Error(`GET spreadsheet headers ${headerRes.status}: ${await headerRes.text()}`);
    }

    const headerBody = (await headerRes.json()) as HeaderResponse;
    headerCells = headerBody.values?.[0] ?? [];
  }

  const keys = columnKeys(headerCells);
  const values: Cell[][] = input.rows.map((row) => {
    if (Array.isArray(row)) return row;

    const objectRow = row as ObjectRow;
    const unknownHeaders = Object.keys(objectRow).filter((key) => columnOf(keys, key) === null);
    if (unknownHeaders.length > 0) {
      throw new Error(
        `Row contains keys that are not tab headers: ${unknownHeaders.join(", ")}. Headers are: ${[...keys.keys()].join(", ")}`,
      );
    }

    const cells: Cell[] = Array.from({ length: keys.size }, () => null);
    for (const [key, value] of Object.entries(objectRow)) {
      const index = columnOf(keys, key) ?? 0;
      while (cells.length <= index) cells.push(null);
      cells[index] = value ?? null;
    }
    return cells;
  });

  const appendRange = encodeURIComponent(`${tab}!A1:Z`);
  const appendRes = await ctx.fetch(
    `/v4/spreadsheets/${encodeURIComponent(id)}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      host: "sheets.googleapis.com",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    },
  );
  if (!appendRes.ok) {
    throw new Error(`POST append rows ${appendRes.status}: ${await appendRes.text()}`);
  }

  const appendBody = (await appendRes.json()) as AppendResponse;
  const updatedRange = appendBody.updates?.updatedRange;
  const updatedRows = appendBody.updates?.updatedRows;

  return {
    updatedRange: typeof updatedRange === "string" ? updatedRange : null,
    rowsAppended: typeof updatedRows === "number" ? updatedRows : null,
  };
};
