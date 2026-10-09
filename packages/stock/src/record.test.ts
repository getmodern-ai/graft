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
        },
      ],
      result: { noted: 202 },
    });
    // The repositories' names are the maintainer's, and scrubbed; the module's note names the first.
    const names = (recording.result as { names: string[] }).names;
    expect(names).toHaveLength(2);
    expect(names).not.toContain("graft");
    expect(recording.exchanges[1]).toMatchObject({ body: { json: { text: names[0] } } });

    const replay = await proveReplay(tool, recording);
    expect(replay.problems).toEqual([]);
    expect(replay.reachedVendor).toHaveLength(1);
  });

  it("scrubs every value of the maintainer's account, and the module's requests and result follow the scrubbed answers", async () => {
    const PLANTED = [
      "Alice Liddell",
      "alice@acme-corp.example",
      "acme-secret-plans",
      "Acme Pty Ltd",
    ];
    const ISSUES = `export default async (input: Input, ctx: Context) => {
  const me = await ctx.fetch("/user");
  const user = (await me.json()) as { login: string; name: string; email: string; company: string };
  const res = await ctx.fetch(\`/repos/\${user.login}/\${input.repo}/issues?state=open\`);
  const issues = (await res.json()) as { number: number; title: string }[];
  return {
    who: \`\${user.name} <\${user.email}>\`,
    shouting: user.company.toUpperCase(),
    titles: issues.map((issue) => issue.title),
    numbers: issues.map((issue) => issue.number),
  };
};
`;
    const issuesTool: StockWorkspaceTool = {
      ...tool,
      name: "open-issues",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" } },
        required: ["repo"],
        additionalProperties: false,
      },
      testInput: { repo: "acme-secret-plans" },
      annotations: { readOnly: true, destructive: false },
      files: [{ path: "index.ts", content: ISSUES }],
    };
    const recorded = await recordStockProof(issuesTool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/user") {
          return Response.json({
            login: "aliceliddell",
            name: "Alice Liddell",
            email: "alice@acme-corp.example",
            company: "Acme Pty Ltd",
          });
        }
        if (url.pathname === "/repos/aliceliddell/acme-secret-plans/issues") {
          return Response.json([
            { number: 4211, title: "Acme Pty Ltd board minutes" },
            { number: 4212, title: "Alice Liddell salary review" },
          ]);
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { recording } = recorded;

    const text = JSON.stringify(recording);
    for (const planted of [...PLANTED, "aliceliddell", "4211", "ACME PTY LTD"]) {
      expect(text, `${planted} survived`).not.toContain(planted);
      expect(decodeURIComponent(text), `${planted} survived`).not.toContain(planted);
    }
    const [first, second] = recording.exchanges;
    const user = (first as { response: { body: { json: Record<string, string> } } }).response.body
      .json;
    const repo = recording.input.repo as string;
    expect(repo).toMatch(/^[a-z]{4}-[a-z]{6}-[a-z]{5}$/);
    // The second read names the scrubbed login and the scrubbed test input, as the module built it.
    expect(second?.url).toBe(
      `https://api.github.com/repos/${user.login}/${repo}/issues?state=open`,
    );
    expect(recording.result).toMatchObject({
      who: `${user.name} <${user.email}>`,
      shouting: user.company?.toUpperCase(),
    });

    const replay = await proveReplay({ ...issuesTool, testInput: recording.input }, recording);
    expect(replay.problems).toEqual([]);
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
