import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Google Sheets' stock modules over shapes the recordings do not hold (GRA-259, Greptile on #198):
 * a row wider than its header, a repeated or blank header, and a header write that fails after the
 * tab exists. The replay proves the recorded path; these prove the rest of the column keying.
 */

type Call = { path: string; init: { method?: string; body?: string } | undefined };
type Module = (input: unknown, ctx: unknown) => Promise<unknown>;

/** Loaded by a computed path, so the type program never reads a module typed by the check. */
async function sheetsModule(name: string): Promise<Module> {
  const url = new URL(`../tools/google-sheets/${name}/index.ts`, import.meta.url);
  return ((await import(fileURLToPath(url))) as { default: Module }).default;
}

function fakeContext(answers: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  return {
    calls,
    ctx: {
      fetch: async (path: string, init?: Call["init"]) => {
        calls.push({ path, init });
        const answer = answers.shift();
        if (!answer) throw new Error(`no answer for ${path}`);
        return Response.json(answer.json, { status: answer.status ?? 200 });
      },
    },
  };
}

const SPREADSHEET = "https://docs.google.com/spreadsheets/d/sheet-id/edit";
const VALUES = [["Name", "", "Name"], ["Alice", "x", "Smith", "paid"], ["Bob"]];

describe("google-sheets__read-rows", () => {
  it("keys every returned cell: past the header, under a blank header and a repeated one", async () => {
    const readRows = await sheetsModule("read-rows");
    const { ctx } = fakeContext([{ json: { values: VALUES } }]);
    const result = (await readRows({ spreadsheet: SPREADSHEET, tab: "Sheet1" }, ctx)) as {
      header: string[];
      rows: Record<string, string>[];
    };
    expect(result.header).toEqual(["Name", "column_B", "Name_2", "column_D"]);
    expect(result.rows[0]).toEqual({
      Name: "Alice",
      column_B: "x",
      Name_2: "Smith",
      column_D: "paid",
    });
    expect(result.rows[1]).toEqual({ Name: "Bob", column_B: "", Name_2: "", column_D: "" });
  });
});

describe("google-sheets__read-rows over a range that starts past A", () => {
  it("names a blank header by the sheet's own column, so append-rows writes it back there", async () => {
    const readRows = await sheetsModule("read-rows");
    const { ctx } = fakeContext([
      {
        json: {
          range: "'Sheet1'!B1:C2",
          values: [
            ["", "Total"],
            ["x", "9"],
          ],
        },
      },
    ]);
    const result = (await readRows(
      { spreadsheet: SPREADSHEET, tab: "Sheet1", range: "B1:C2" },
      ctx,
    )) as { header: string[]; rows: Record<string, string>[] };
    expect(result.header).toEqual(["column_B", "Total"]);
    expect(result.rows).toEqual([{ column_B: "x", Total: "9" }]);
  });
});

describe("google-sheets__find-rows", () => {
  it("keys a matching row's every cell as read-rows does", async () => {
    const findRows = await sheetsModule("find-rows");
    const { ctx } = fakeContext([{ json: { values: VALUES } }]);
    const result = (await findRows(
      { spreadsheet: SPREADSHEET, tab: "Sheet1", column: "name", value: "alice" },
      ctx,
    )) as { matches: Array<{ rowNumber: number; row: Record<string, string> }> };
    expect(result.matches).toEqual([
      {
        rowNumber: 2,
        row: { Name: "Alice", column_B: "x", Name_2: "Smith", column_D: "paid" },
      },
    ]);
  });
});

describe("google-sheets__append-rows", () => {
  it("takes an object row keyed as read-rows answers, blank and repeated headers included", async () => {
    const appendRows = await sheetsModule("append-rows");
    const { ctx, calls } = fakeContext([
      { json: { values: [VALUES[0]] } },
      { json: { updates: { updatedRange: "Sheet1!A3:D3", updatedRows: 1 } } },
    ]);
    const result = await appendRows(
      {
        spreadsheet: SPREADSHEET,
        tab: "Sheet1",
        rows: [{ Name: "Carol", column_B: "y", Name_2: "Jones", column_D: "due" }],
      },
      ctx,
    );
    expect(result).toEqual({ updatedRange: "Sheet1!A3:D3", rowsAppended: 1 });
    expect(JSON.parse(calls[1]?.init?.body ?? "{}")).toEqual({
      values: [["Carol", "y", "Jones", "due"]],
    });
  });

  it("refuses a key that names no column", async () => {
    const appendRows = await sheetsModule("append-rows");
    const { ctx } = fakeContext([{ json: { values: [VALUES[0]] } }]);
    await expect(
      appendRows({ spreadsheet: SPREADSHEET, tab: "Sheet1", rows: [{ Surname: "Jones" }] }, ctx),
    ).rejects.toThrow(/Surname/);
  });
});

describe("google-sheets__add-tab", () => {
  it("answers the tab it created when the header write fails, rather than throwing", async () => {
    const addTab = await sheetsModule("add-tab");
    const { ctx } = fakeContext([
      { json: { replies: [{ addSheet: { properties: { sheetId: 7, title: "Q3" } } }] } },
      { status: 500, json: { error: { message: "backend error" } } },
    ]);
    const result = (await addTab(
      { spreadsheet: SPREADSHEET, title: "Q3", header: ["Name"] },
      ctx,
    )) as { sheetId: number; title: string; headerError?: string };
    expect(result).toMatchObject({ sheetId: 7, title: "Q3" });
    expect(result.headerError).toMatch(/tab was created/);
  });
});
