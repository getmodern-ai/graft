import type { UpstreamRequest } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { jsonTextNotes, proveReplay } from "./harness";
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

  it("redacts every encoded form of a basic credential the vendor echoes, in the recording and in a failure's sentences", async () => {
    const username = "maintainer";
    const password = "pa55~word>>??0123";
    const pair = Buffer.from(`${username}:${password}`, "utf8");
    const forms = {
      // The bare base64 pair the header carries (Greptile on #191), which the proxy also redacts.
      note: pair.toString("base64"),
      // Forms the proxy does not know: the pair as base64url, the password percent-encoded and as
      // base64url on its own.
      url: pair.toString("base64url"),
      query: encodeURIComponent(password),
      alone: Buffer.from(password, "utf8").toString("base64url"),
    };
    const echoTool: StockWorkspaceTool = {
      ...tool,
      name: "echo",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      testInput: {},
      annotations: { readOnly: true, destructive: false },
      files: [
        {
          path: "index.ts",
          content: `export default async (_input: Input, ctx: Context) => {
  const res = await ctx.fetch("/echo");
  if (!res.ok) throw new Error(\`GET /echo \${res.status}: \${await res.text()}\`);
  return (await res.json()) as Record<string, string>;
};
`,
        },
      ],
    };
    const connection = {
      scheme: "basic" as const,
      schemeConfig: {},
      credential: { username, password },
    };
    const recorded = await recordStockProof(echoTool, {
      connection,
      upstreamFetch: async (request) =>
        request.headers.get("authorization") === `Basic ${forms.note}`
          ? Response.json(forms)
          : Response.json({ message: "Bad credentials" }, { status: 401 }),
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const written = JSON.stringify(recorded.recording);
    for (const [where, form] of Object.entries({ ...forms, password })) {
      expect(written, `the recording carries the ${where} form`).not.toContain(form);
    }
    expect((await proveReplay(echoTool, recorded.recording)).problems).toEqual([]);

    const failed = await recordStockProof(echoTool, {
      connection,
      upstreamFetch: async () =>
        Response.json({ message: `refused ${forms.url} and ${forms.query}` }, { status: 500 }),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    for (const form of [forms.url, forms.query, password]) {
      expect(failed.problems.join("\n")).not.toContain(form);
    }
  });

  it("keeps a query-parameter key out of the recording in every form, and replays without it", async () => {
    const key = "qk/0123+456789?abc";
    const queryTool: StockWorkspaceTool = {
      ...tool,
      name: "who",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      testInput: {},
      annotations: { readOnly: true, destructive: false },
      files: [
        {
          path: "index.ts",
          content: `export default async (_input: Input, ctx: Context) => {
  const res = await ctx.fetch("/who?fields=name");
  return (await res.json()) as Record<string, string>;
};
`,
        },
      ],
    };
    const seen: string[] = [];
    const recorded = await recordStockProof(queryTool, {
      connection: {
        scheme: "api_key_query",
        schemeConfig: { queryParam: "key" },
        credential: { apiKey: key },
      },
      upstreamFetch: async (request) => {
        seen.push(request.url);
        const url = new URL(request.url);
        // The vendor quotes the query back as it arrived, encoded.
        return Response.json({
          name: "graft",
          query: url.search,
          encoded: encodeURIComponent(key),
        });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    // The key did go out, percent-encoded in the query.
    expect(seen[0]).toContain(encodeURIComponent(key));
    const written = JSON.stringify(recorded.recording);
    for (const form of [key, encodeURIComponent(key)]) expect(written).not.toContain(form);
    expect((await proveReplay(queryTool, recorded.recording)).problems).toEqual([]);
  });

  it("records parallel reads in the order the module issued them, though the vendor answered them out of order, and replays them", async () => {
    const parallelTool: StockWorkspaceTool = {
      ...tool,
      name: "both",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      testInput: {},
      annotations: { readOnly: true, destructive: false },
      files: [
        {
          path: "index.ts",
          content: `export default async (_input: Input, ctx: Context) => {
  const [slow, fast] = await Promise.all([ctx.fetch("/slow"), ctx.fetch("/fast")]);
  const a = (await slow.json()) as { v: string };
  const b = (await fast.json()) as { v: string };
  return { slow: a.v, fast: b.v };
};
`,
        },
      ],
    };
    let fastAnswered: () => void = () => {};
    const fastDone = new Promise<void>((resolve) => {
      fastAnswered = resolve;
    });
    const answered: string[] = [];
    const recorded = await recordStockProof(parallelTool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: async (request) => {
        const path = new URL(request.url).pathname;
        // `/slow` answers only once `/fast` has, or after a second if `/fast` never comes.
        if (path === "/slow") {
          await Promise.race([fastDone, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        }
        answered.push(path);
        if (path === "/fast") fastAnswered();
        return Response.json({ v: path });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    expect(answered).toEqual(["/fast", "/slow"]);
    expect(recorded.recording.exchanges.map((exchange) => new URL(exchange.url).pathname)).toEqual([
      "/slow",
      "/fast",
    ]);
    expect(recorded.recording.result).toEqual({ slow: "/slow", fast: "/fast" });
    expect((await proveReplay(parallelTool, recorded.recording)).problems).toEqual([]);
  });

  it("hands the module a JSON body as the replay will serve it, so text it reads records and replays alike", async () => {
    const textTool: StockWorkspaceTool = {
      ...tool,
      name: "raw",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      testInput: {},
      annotations: { readOnly: true, destructive: false },
      files: [
        {
          path: "index.ts",
          content: `export default async (_input: Input, ctx: Context) => {
  const res = await ctx.fetch("/raw");
  return { text: await res.text() };
};
`,
        },
      ],
    };
    const recorded = await recordStockProof(textTool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      // The vendor's own formatting: indentation the re-serialised body does not have.
      upstreamFetch: async () =>
        new Response('{\n  "name":   "graft"\n}\n', {
          headers: { "content-type": "application/json" },
        }),
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    expect(recorded.recording.result).toEqual({ text: '{"name":"graft"}' });
    expect((await proveReplay(textTool, recorded.recording)).problems).toEqual([]);
    expect(jsonTextNotes(textTool, recorded.recording)).toEqual([
      expect.stringMatching(
        /^stock tool github__raw: note: index\.ts reads a body with \.text\(\)/,
      ),
    ]);
    expect(jsonTextNotes(tool, recorded.recording)).toEqual([]);
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
