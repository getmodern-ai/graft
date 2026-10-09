type SpreadsheetMetadata = {
  sheets?: Array<{ properties?: { title?: string } }>;
};

type ValueRange = {
  values?: unknown[][];
};

const normalized = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLocaleLowerCase();

const columnLetter = (index: number): string => {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};

const encodePathPart = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export default async (input: Input, ctx: Context) => {
  const spreadsheetInput = input.spreadsheet.trim();
  const marker = "/d/";
  const markerIndex = spreadsheetInput.indexOf(marker);
  const spreadsheetId =
    markerIndex >= 0
      ? spreadsheetInput.slice(markerIndex + marker.length).split("/")[0]
      : spreadsheetInput;

  if (!spreadsheetId) {
    throw new Error("The spreadsheet URL or ID does not contain a spreadsheet ID.");
  }

  let tab = input.tab?.trim();
  if (!tab) {
    const metadataPath = `/v4/spreadsheets/${encodePathPart(spreadsheetId)}?fields=sheets.properties.title`;
    const metadataResponse = await ctx.fetch(metadataPath, {
      host: "sheets.googleapis.com",
    });
    if (!metadataResponse.ok) {
      throw new Error(
        `GET spreadsheet metadata ${metadataResponse.status}: ${await metadataResponse.text()}`,
      );
    }

    const metadata = (await metadataResponse.json()) as SpreadsheetMetadata;
    tab = metadata.sheets?.[0]?.properties?.title?.trim();
    if (!tab) {
      throw new Error("The spreadsheet has no tab with a title.");
    }
  }

  const escapedTab = tab.replaceAll("'", "''");
  const range = `'${escapedTab}'!A1:Z`;
  const valuesPath = `/v4/spreadsheets/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}?majorDimension=ROWS`;
  const valuesResponse = await ctx.fetch(valuesPath, {
    host: "sheets.googleapis.com",
  });
  if (!valuesResponse.ok) {
    throw new Error(`GET sheet values ${valuesResponse.status}: ${await valuesResponse.text()}`);
  }

  const valueRange = (await valuesResponse.json()) as ValueRange;
  const values = valueRange.values ?? [];
  const headerCells = values[0] ?? [];
  const headers = headerCells.map((cell, index) => {
    const text = String(cell ?? "").trim();
    return text || `column_${columnLetter(index)}`;
  });

  const wantedColumn = normalized(input.column);
  const columnIndex = headerCells.findIndex((cell) => normalized(cell) === wantedColumn);
  if (columnIndex < 0) {
    const existingHeaders = headerCells
      .map((cell) => String(cell ?? "").trim())
      .filter((header) => header.length > 0);
    throw new Error(
      `Column "${input.column}" was not found. Existing headers: ${existingHeaders.length > 0 ? existingHeaders.join(", ") : "none"}`,
    );
  }

  const wantedValue = normalized(input.value);
  const contains = input.contains ?? false;
  const limit = input.limit ?? 50;
  const matches: Array<{ rowNumber: number; row: Record<string, string> }> = [];

  for (let rowIndex = 1; rowIndex < values.length && matches.length < limit; rowIndex += 1) {
    const cells = values[rowIndex] ?? [];
    const cellValue = normalized(cells[columnIndex]);
    const isMatch = contains ? cellValue.includes(wantedValue) : cellValue === wantedValue;
    if (!isMatch) continue;

    const row = Object.create(null) as Record<string, string>;
    for (let columnIndexInRow = 0; columnIndexInRow < headers.length; columnIndexInRow += 1) {
      row[headers[columnIndexInRow]] = String(cells[columnIndexInRow] ?? "");
    }
    matches.push({ rowNumber: rowIndex + 1, row });
  }

  return { tab, matches };
};
