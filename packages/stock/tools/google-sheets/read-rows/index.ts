type SpreadsheetMetadata = {
  sheets?: Array<{ properties?: { title?: string } }>;
};

type ValueRange = {
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
  const header = rawHeader.map((value, index) => {
    const text = value == null ? "" : String(value);
    return text === "" ? `column_${columnLetter(index)}` : text;
  });
  const allDataRows = values.slice(1);
  const limit = input.limit ?? 100;
  const rows = allDataRows.slice(0, limit).map((sourceRow) => {
    const row: Record<string, string> = {};
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
