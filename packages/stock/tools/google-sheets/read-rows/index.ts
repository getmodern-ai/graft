type SpreadsheetMetadata = {
  sheets?: Array<{ properties?: { title?: string } }>;
};

type ValueRange = {
  range?: string;
  values?: unknown[][];
};

function spreadsheetId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("/d/")) {
    const match = trimmed.match(/\/d\/([^/]+)/);
    if (!match?.[1]) throw new Error("The spreadsheet URL does not contain an id after /d/.");
    return match[1];
  }
  if (!trimmed) throw new Error("spreadsheet must not be empty.");
  return trimmed;
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

/** The 0-based index of the column a range starts at (`B1:C2` is 1, `'Tab'!AA3:AB` is 26), 0 if none. */
function startColumn(range: string): number {
  const cells = range.includes("!") ? range.slice(range.lastIndexOf("!") + 1) : range;
  const letters = cells.match(/^\$?([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (!letters) return 0;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * One key per column across the widest row: a blank header is `column_<letter>`, named by the
 * sheet's own column (the range's start added, so `B1:C2` names B and C, as append-rows reads them,
 * Greptile on #198), and a repeated one takes `_2`, `_3`, so no returned cell is dropped or
 * overwritten. append-rows reads keys the same way.
 */
function columnKeys(headerCells: unknown[], width: number, offset: number): string[] {
  const keys: string[] = [];
  const used = new Set<string>();
  for (let index = 0; index < width; index += 1) {
    const text = String(headerCells[index] ?? "").trim();
    const base = text || `column_${columnLetter(offset + index)}`;
    let key = base;
    for (let suffix = 2; used.has(key); suffix += 1) key = `${base}_${suffix}`;
    used.add(key);
    keys.push(key);
  }
  return keys;
}

export default async (input: Input, ctx: Context) => {
  const id = spreadsheetId(input.spreadsheet);
  const encodedId = encodeURIComponent(id);
  let tab = input.tab?.trim();

  if (!tab) {
    const metadataPath = `/v4/spreadsheets/${encodedId}?fields=sheets.properties.title`;
    const metadataResponse = await ctx.fetch(metadataPath, {
      host: "sheets.googleapis.com",
    });
    if (!metadataResponse.ok) {
      throw new Error(
        `GET spreadsheet metadata ${metadataResponse.status}: ${await metadataResponse.text()}`,
      );
    }
    const metadata = (await metadataResponse.json()) as SpreadsheetMetadata;
    tab = metadata.sheets?.[0]?.properties?.title;
    if (!tab) throw new Error("The spreadsheet has no tab to read.");
  }

  const escapedTab = tab.replaceAll("'", "''");
  const cellRange = input.range?.trim() || "A1:Z";
  const a1Range = `'${escapedTab}'!${cellRange}`;
  const valuesPath = `/v4/spreadsheets/${encodedId}/values/${encodeURIComponent(a1Range)}?majorDimension=ROWS`;
  const valuesResponse = await ctx.fetch(valuesPath, {
    host: "sheets.googleapis.com",
  });
  if (!valuesResponse.ok) {
    throw new Error(
      `GET spreadsheet values ${valuesResponse.status}: ${await valuesResponse.text()}`,
    );
  }

  const valueRange = (await valuesResponse.json()) as ValueRange;
  const values = Array.isArray(valueRange.values) ? valueRange.values : [];
  const rawHeader = values[0] ?? [];
  const width = values.reduce((widest, row) => Math.max(widest, row?.length ?? 0), 0);
  const header = columnKeys(rawHeader, width, startColumn(valueRange.range ?? cellRange));
  const allDataRows = values.slice(1);
  const limit = input.limit ?? 100;
  const rows = allDataRows.slice(0, limit).map((sourceRow) => {
    const row = Object.create(null) as Record<string, string>;
    for (let index = 0; index < header.length; index += 1) {
      const value = sourceRow[index];
      row[header[index]] = value == null ? "" : String(value);
    }
    return row;
  });

  return {
    tab,
    header,
    rows,
    totalRowCount: allDataRows.length,
    truncated: allDataRows.length > limit,
  };
};
