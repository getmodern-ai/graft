export default async (input: Input, ctx: Context) => {
  const spreadsheet = input.spreadsheet.trim();
  const marker = "/d/";
  const markerIndex = spreadsheet.indexOf(marker);
  const spreadsheetId =
    markerIndex >= 0 ? spreadsheet.slice(markerIndex + marker.length).split("/")[0] : spreadsheet;

  if (!spreadsheetId) {
    throw new Error("The spreadsheet URL or id does not contain a spreadsheet id");
  }

  const quotedTab = input.tab.replaceAll("'", "''");
  const a1Range = `'${quotedTab}'!${input.range}`;
  const path = `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}?valueInputOption=USER_ENTERED`;

  const res = await ctx.fetch(path, {
    host: "sheets.googleapis.com",
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      range: a1Range,
      majorDimension: "ROWS",
      values: input.values,
    }),
  });

  if (!res.ok) {
    throw new Error(`PUT ${path} ${res.status}: ${await res.text()}`);
  }

  const result = (await res.json()) as {
    updatedRange?: string;
    updatedRows?: number;
    updatedColumns?: number;
    updatedCells?: number;
  };

  return {
    updatedRange: result.updatedRange ?? null,
    updatedRows: result.updatedRows ?? null,
    updatedColumns: result.updatedColumns ?? null,
    updatedCells: result.updatedCells ?? null,
  };
};
