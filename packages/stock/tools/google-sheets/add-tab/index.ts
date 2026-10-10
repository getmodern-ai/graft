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
  const properties = added.replies?.[0]?.addSheet?.properties;
  const created = {
    sheetId: properties?.sheetId ?? null,
    title: properties?.title ?? null,
  };

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
    // The tab exists by now, so a failed header is answered beside it rather than thrown: a retry
    // of the whole call would fail on the title it has just taken.
    if (!headerResponse.ok) {
      return {
        ...created,
        headerError: `The tab was created, but writing its header failed (PUT spreadsheet values ${headerResponse.status}: ${await headerResponse.text()}). Write the header with google-sheets__update-range.`,
      };
    }
  }

  return created;
};
