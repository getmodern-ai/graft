import type { UpstreamRequest } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { dryRunStockTool, type PreviewedWrite, stockConnectionFor } from "./dry-run";
import { readStockWorkspace, type StockWorkspaceTool } from "./workspace";

/**
 * The Google Drive stock tools' branches the recordings do not reach (Greptile on #193): a stored
 * text file is read by byte range so an excerpt never asks for more than it returns, and a move
 * names the parents it adds and removes.
 */

async function driveTool(
  name: string,
  testInput: Record<string, unknown>,
): Promise<StockWorkspaceTool> {
  const tool = (await readStockWorkspace()).find(
    (candidate) => candidate.vendor === "google-drive" && candidate.name === name,
  );
  if (!tool) throw new Error(`no google-drive/${name} in the workspace`);
  return { ...tool, testInput };
}

async function run(
  tool: StockWorkspaceTool,
  vendor: (request: UpstreamRequest) => Response,
): Promise<{
  result: unknown;
  seen: UpstreamRequest[];
  writes: PreviewedWrite[];
  sent: { method: string; url: string }[];
}> {
  const connection = stockConnectionFor(tool, null, false);
  if (typeof connection === "string") throw new Error(connection);
  const seen: UpstreamRequest[] = [];
  const writes: PreviewedWrite[] = [];
  const sent: { method: string; url: string }[] = [];
  const dryRun = await dryRunStockTool({
    tool,
    connection,
    credential: {},
    upstreamFetch: async (request) => {
      seen.push(request);
      return vendor(request);
    },
    onPreview: (write) => writes.push(write),
    onRequest: (method, url) => sent.push({ method, url }),
  });
  if (!dryRun.ran) throw new Error(`the runner did not run: ${dryRun.stderr}`);
  if (dryRun.report.moduleError) throw new Error(dryRun.report.moduleError);
  return { result: dryRun.report.moduleResult, seen, writes, sent };
}

/** The query of the module's one PATCH, as it reached the proxy. */
function patchQuery(sent: { method: string; url: string }[]): URLSearchParams {
  const patches = sent.filter((request) => request.method === "PATCH");
  expect(patches).toHaveLength(1);
  return new URL(patches[0]?.url ?? "").searchParams;
}

const TEXT_FILE = { id: "file1", name: "notes.txt", mimeType: "text/plain", size: "11534336" };

/** A vendor that honours `Range` over a large text file, as Drive's `alt=media` does. */
function rangedVendor(content: string) {
  return (request: UpstreamRequest): Response => {
    const url = new URL(request.url);
    if (url.searchParams.get("alt") !== "media") return Response.json(TEXT_FILE);
    const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (!range) return new Response(content, { headers: { "content-type": "text/plain" } });
    const bytes = new TextEncoder().encode(content);
    const end = Math.min(Number(range[1]), bytes.length - 1);
    return new Response(bytes.slice(0, end + 1), {
      status: 206,
      headers: {
        "content-type": "text/plain",
        "content-range": `bytes 0-${end}/${bytes.length}`,
      },
    });
  };
}

describe("google-drive__read-file-content", () => {
  it("reads a stored text file by byte range and says it was shortened", async () => {
    const tool = await driveTool("read-file-content", { fileId: "file1", maxCharacters: 100 });
    const { result, seen } = await run(tool, rangedVendor("a".repeat(1_000_000)));

    const download = seen.find((request) => request.url.includes("alt=media"));
    expect(download?.headers.get("range")).toBe("bytes=0-402");
    expect(result).toMatchObject({
      readable: true,
      exportedAs: "text/plain",
      content: "a".repeat(100),
      truncated: true,
    });
  });

  it("drops a multibyte character the range cut through", async () => {
    const tool = await driveTool("read-file-content", { fileId: "file1", maxCharacters: 2 });
    const { result } = await run(tool, rangedVendor("€".repeat(10)));
    expect(result).toMatchObject({ content: "€€", truncated: true });
  });

  it("still says it was shortened when a byte-order mark took part of the range", async () => {
    const tool = await driveTool("read-file-content", { fileId: "file1", maxCharacters: 1 });
    const { result } = await run(tool, rangedVendor("﻿abcdefgh"));
    expect(result).toMatchObject({ content: "a", truncated: true });
  });

  it("reads a file shorter than the range whole", async () => {
    const tool = await driveTool("read-file-content", { fileId: "file1", maxCharacters: 100 });
    const { result } = await run(tool, rangedVendor("short"));
    expect(result).toMatchObject({ content: "short", truncated: false });
  });

  it("answers an empty file, which Drive refuses a range over, as empty", async () => {
    const tool = await driveTool("read-file-content", { fileId: "file1" });
    const { result } = await run(tool, (request) =>
      new URL(request.url).searchParams.get("alt") === "media"
        ? new Response("", { status: 416 })
        : Response.json(TEXT_FILE),
    );
    expect(result).toMatchObject({ readable: true, content: "", truncated: false });
  });

  it("exports a spreadsheet as CSV without a range", async () => {
    const tool = await driveTool("read-file-content", { fileId: "sheet1", maxCharacters: 5 });
    const { result, seen } = await run(tool, (request) =>
      request.url.includes("/export")
        ? new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } })
        : Response.json({
            id: "sheet1",
            name: "Sheet",
            mimeType: "application/vnd.google-apps.spreadsheet",
          }),
    );
    const exported = seen.find((request) => request.url.includes("/export"));
    expect(new URL(exported?.url ?? "").searchParams.get("mimeType")).toBe("text/csv");
    expect(exported?.headers.get("range")).toBeNull();
    expect(result).toMatchObject({ exportedAs: "text/csv", content: "a,b\n1", truncated: true });
  });

  it("downloads nothing for a type it cannot read", async () => {
    const tool = await driveTool("read-file-content", { fileId: "pdf1" });
    const { result, seen } = await run(tool, () =>
      Response.json({ id: "pdf1", name: "a.pdf", mimeType: "application/pdf" }),
    );
    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ readable: false, content: "" });
  });
});

describe("google-drive__move-file", () => {
  const vendor = () => Response.json({ parents: ["old1", "old2"] });

  it("adds the folder and removes every current parent", async () => {
    const tool = await driveTool("move-file", { fileId: "file1", folderId: "dest" });
    const { writes, sent } = await run(tool, vendor);
    expect(writes).toHaveLength(1);
    const query = patchQuery(sent);
    expect(query.get("addParents")).toBe("dest");
    expect(query.get("removeParents")).toBe("old1,old2");
    expect(writes[0]?.body).toEqual({ json: {} });
  });

  it("renames in place without touching the parents", async () => {
    const tool = await driveTool("move-file", { fileId: "file1", newName: "Renamed" });
    const { writes, seen, sent } = await run(tool, vendor);
    expect(seen).toHaveLength(0);
    const query = patchQuery(sent);
    expect(query.has("addParents")).toBe(false);
    expect(query.has("removeParents")).toBe(false);
    expect(writes[0]?.body).toEqual({ json: { name: "Renamed" } });
  });
});
