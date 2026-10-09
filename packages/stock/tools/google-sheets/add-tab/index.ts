type BatchUpdateResponse = {
  replies?: Array<{
    addSheet?: {
      properties?: {
        sheetId?: number;
        title?: string;
      };
    };
  }>;
};

function spreadsheetId(value: string): string {
  const marker = "/d/";
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) return value.trim();
  return value.slice(markerIndex + marker.length).split("/")[0];
}

export default async (input: Input, ctx: Context) => {
  const id = spreadsheetId(input.spreadsheet);
  if (!id) throw new Error("The spreadsheet URL or id does not contain a spreadsheet id.");

  const addResponse = await ctx.fetch(`/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, {
    host: "sheets.googleapis.com",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: input.title } } }],
    }),
  });
  if (!addResponse.ok) {
    throw new Error(
      `POST spreadsheet batchUpdate ${addResponse.status}: ${await addResponse.text()}`,
    );
  }

  const added = (await addResponse.json()) as BatchUpdateResponse;

  if (input.header !== undefined) {
    const quotedTitle = `'${input.title.replaceAll("'", "''")}'!A1`;
    const headerResponse = await ctx.fetch(
      `/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(quotedTitle)}?valueInputOption=RAW`,
      {
        host: "sheets.googleapis.com",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [input.header] }),
      },
    );
    if (!headerResponse.ok) {
      throw new Error(
        `PUT spreadsheet values ${headerResponse.status}: ${await headerResponse.text()}`,
      );
    }
  }

  const properties = added.replies?.[0]?.addSheet?.properties;
  return {
    sheetId: properties?.sheetId ?? null,
    title: properties?.title ?? null,
  };
};
