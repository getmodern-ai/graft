type SpreadsheetResponse = {
  spreadsheetId?: string;
  properties?: {
    title?: string;
  };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      index?: number;
      gridProperties?: {
        rowCount?: number;
        columnCount?: number;
      };
    };
  }>;
};

export default async (input: Input, ctx: Context) => {
  const value = input.spreadsheet.trim();
  const marker = "/d/";
  const spreadsheetId = value.includes(marker)
    ? value.slice(value.indexOf(marker) + marker.length).split("/")[0]
    : value;

  if (!spreadsheetId) {
    throw new Error("The spreadsheet URL or ID does not contain a spreadsheet ID.");
  }

  const fields =
    "spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))";
  const path = `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`;
  const res = await ctx.fetch(path, { host: "sheets.googleapis.com" });

  if (!res.ok) {
    throw new Error(`GET spreadsheet ${res.status}: ${await res.text()}`);
  }

  const spreadsheet = (await res.json()) as SpreadsheetResponse;
  const id = spreadsheet.spreadsheetId ?? spreadsheetId;

  return {
    id,
    title: spreadsheet.properties?.title ?? null,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    tabs: (spreadsheet.sheets ?? []).map((sheet) => ({
      title: sheet.properties?.title ?? null,
      sheetId: sheet.properties?.sheetId ?? null,
      index: sheet.properties?.index ?? null,
      rowCount: sheet.properties?.gridProperties?.rowCount ?? null,
      columnCount: sheet.properties?.gridProperties?.columnCount ?? null,
    })),
  };
};
