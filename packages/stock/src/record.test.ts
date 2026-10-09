import type { UpstreamRequest } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { proveReplay } from "./harness";
import { recordStockProof } from "./record";
import type { StockWorkspaceTool } from "./workspace";

/**
 * The build command's recording (GRA-246) over a keyed starter: the proof's reads with the
 * vendor's answers, its write from the proxy's preview, its result, the credential redacted by
 * value wherever the vendor echoed it, and a recording the harness replays as it stands.
 */

const TOKEN = "planted-secret-0123456789abcdef";

const MODULE = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(\`/user/repos?per_page=\${input.limit}\`);
  if (!res.ok) throw new Error(\`GET /user/repos \${res.status}\`);
  const repos = (await res.json()) as { name: string; echo: string }[];
  const note = await ctx.fetch("/user/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: repos[0]?.name ?? "none" }),
  });
  return { names: repos.map((repo) => repo.name), echo: repos[0]?.echo, noted: note.status };
};
`;

const tool: StockWorkspaceTool = {
  vendor: "github",
  name: "list-repos",
  description: "Lists repositories and notes the first.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" } },
    required: ["limit"],
    additionalProperties: false,
  },
  hosts: ["api.github.com"],
  testInput: { limit: 2 },
  annotations: { readOnly: false, destructive: false },
  files: [{ path: "index.ts", content: MODULE }],
  sourceHash: "unused",
};

function vendor(seen: UpstreamRequest[]) {
  return async (request: UpstreamRequest) => {
    seen.push(request);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    // The vendor echoes the credential back, as a careless API might: the recording must not.
    return Response.json([
      { name: "graft", echo: `token ${TOKEN} seen` },
      { name: "cando", echo: "" },
    ]);
  };
}

describe("recordStockProof", () => {
  it("records the reads, the previewed write and the result, with the credential redacted, and the harness replays it", async () => {
    const seen: UpstreamRequest[] = [];
    const recorded = await recordStockProof(tool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: vendor(seen),
      now: () => new Date("2026-10-09T10:00:00Z"),
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { recording } = recorded;

    // The vendor saw the credential the proxy injected, and only the read.
    expect(seen.map((request) => request.method)).toEqual(["GET"]);
    expect(JSON.stringify(recording)).not.toContain(TOKEN);
    expect(recording).toMatchObject({
      format: 1,
      tool: "github__list-repos",
      recordedAt: "2026-10-09T10:00:00.000Z",
      input: { limit: 2 },
      exchanges: [
        {
          kind: "read",
          method: "GET",
          url: "https://api.github.com/user/repos?per_page=2",
          response: { status: 200, headers: { "content-type": "application/json" } },
        },
        {
          kind: "write",
          method: "POST",
          url: "https://api.github.com/user/notes",
          body: { json: { text: "graft" } },
        },
      ],
      result: { names: ["graft", "cando"], noted: 202 },
    });

    const replay = await proveReplay(tool, recording);
    expect(replay.problems).toEqual([]);
    expect(replay.reachedVendor).toHaveLength(1);
  });

  it("answers the failed dry run's sentence, with the credential redacted, and no recording", async () => {
    const recorded = await recordStockProof(tool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: async () => Response.json({ message: `no such ${TOKEN}` }, { status: 500 }),
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.problems.join("\n")).toContain(
      "stock tool github__list-repos: its dry run did not pass",
    );
    expect(recorded.problems.join("\n")).not.toContain(TOKEN);
  });

  it("refuses a keyed starter with no connection", async () => {
    const recorded = await recordStockProof(tool, { connection: null });
    expect(recorded).toEqual({
      ok: false,
      problems: [
        "stock tool github__list-repos: there is no live connection for github; give it under GRAFT_STOCK_LIVE_CONNECTIONS",
      ],
    });
  });
});
