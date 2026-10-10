type CreatedSpreadsheet = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  sheets?: Array<{ properties?: { title?: string } }>;
};

export default async (input: Input, ctx: Context) => {
  const body: {
    properties: { title: string };
    sheets?: Array<{
      properties: { title: string };
      data?: Array<{
        startRow: number;
        startColumn: number;
        rowData: Array<{
          values: Array<{
            userEnteredValue: { stringValue: string };
          }>;
        }>;
      }>;
    }>;
  } = {
    properties: { title: input.title },
  };

  if (input.tabs && input.tabs.length > 0) {
    body.sheets = input.tabs.map((title) => {
      const sheet: {
        properties: { title: string };
        data?: Array<{
          startRow: number;
          startColumn: number;
          rowData: Array<{
            values: Array<{
              userEnteredValue: { stringValue: string };
            }>;
          }>;
        }>;
      } = { properties: { title } };

      if (input.header && input.header.length > 0) {
        sheet.data = [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              {
                values: input.header.map((value) => ({
                  userEnteredValue: { stringValue: value },
                })),
              },
            ],
          },
        ];
      }

      return sheet;
    });
  }

  const res = await ctx.fetch("/v4/spreadsheets", {
    host: "sheets.googleapis.com",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`POST /v4/spreadsheets ${res.status}: ${await res.text()}`);
  }

  const created = (await res.json()) as CreatedSpreadsheet;
  const tabTitles = created.sheets
    ? created.sheets
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => typeof title === "string")
    : null;

  return {
    spreadsheet: created.spreadsheetId ?? null,
    url: created.spreadsheetUrl ?? null,
    tabs: tabTitles,
  };
};
