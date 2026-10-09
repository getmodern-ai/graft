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

function quotedTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

export default async (input: Input, ctx: Context) => {
  const id = spreadsheetId(input.spreadsheet);
  const tab = quotedTab(input.tab);
  const hasObjectRows = input.rows.some((row) => !Array.isArray(row));
  let headers: string[] = [];

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
    headers = (headerBody.values?.[0] ?? []).map((value) => String(value ?? ""));
  }

  const values: Cell[][] = input.rows.map((row) => {
    if (Array.isArray(row)) return row;

    const objectRow = row as ObjectRow;
    const unknownHeaders = Object.keys(objectRow).filter((key) => !headers.includes(key));
    if (unknownHeaders.length > 0) {
      throw new Error(
        `Row contains keys that are not tab headers: ${unknownHeaders.join(", ")}. Headers are: ${headers.join(", ")}`,
      );
    }

    return headers.map((header) => objectRow[header] ?? null);
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
