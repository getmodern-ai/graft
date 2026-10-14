import type { UpstreamRequest } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { jsonTextNotes, proveReplay } from "./harness";
import type { LiveConnection } from "./mode";
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

  it("records a POST the reviewed table calls a read with the body the module sent over the scrubbed input, and replays it by that body (GRA-260)", async () => {
    const SEARCH = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch("/search", {
    method: "POST",
    headers: { "content-type": "application/json", "Notion-Version": "2025-09-03" },
    body: JSON.stringify({ query: input.query, page_size: 2 }),
  });
  if (!res.ok) throw new Error(\`POST /search \${res.status}\`);
  const body = (await res.json()) as { results: { id: string }[] };
  return { ids: body.results.map((result) => result.id) };
};
`;
    const searchTool: StockWorkspaceTool = {
      ...tool,
      vendor: "notion",
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      hosts: ["api.notion.com"],
      testInput: { query: "Acme board minutes" },
      annotations: { readOnly: true, destructive: false },
      files: [{ path: "index.ts", content: SEARCH }],
    };
    const seen: UpstreamRequest[] = [];
    const recorded = await recordStockProof(searchTool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: async (request) => {
        seen.push(request);
        return Response.json({ results: [{ id: "page-acme-0001" }, { id: "page-acme-0002" }] });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { recording } = recorded;

    // The search reached the vendor once, as the read the proxy's dry run lets through.
    expect(seen.map((request) => request.method)).toEqual(["POST"]);
    const text = JSON.stringify(recording);
    for (const planted of ["Acme board minutes", "page-acme-0001"]) {
      expect(text, `${planted} survived`).not.toContain(planted);
    }
    expect(recording.exchanges).toHaveLength(1);
    // The body is the module's over the scrubbed input, not the first run's.
    expect(recording.exchanges[0]).toMatchObject({
      kind: "read",
      method: "POST",
      url: "https://api.notion.com/v1/search",
      body: { json: { query: recording.input.query, page_size: 2 } },
    });

    const replayed = { ...searchTool, testInput: recording.input };
    expect((await proveReplay(replayed, recording)).problems).toEqual([]);
    // A body the recording does not hold is not the recorded read.
    const other = await proveReplay(
      {
        ...replayed,
        files: [{ path: "index.ts", content: SEARCH.replace("page_size: 2", "page_size: 3") }],
      },
      recording,
    );
    expect(other.problems.join("\n")).toContain("its read 1 disagrees with the recording");
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
    // Re-serialised, so none of the vendor's whitespace; and scrubbed, so not the vendor's value.
    const { text } = recorded.recording.result as { text: string };
    expect(text).toMatch(/^\{"name":"[^"]+"\}$/);
    expect(text).not.toContain("graft");
    expect((await proveReplay(textTool, recorded.recording)).problems).toEqual([]);
    expect(jsonTextNotes(textTool, recorded.recording)).toEqual([
      expect.stringMatching(
        /^stock tool github__raw: note: index\.ts reads a body with \.text\(\)/,
      ),
    ]);
    expect(jsonTextNotes(tool, recorded.recording)).toEqual([]);
  });

  it("records a test input scrubbed within its schema, and fails a scrub the schema leaves no room for", async () => {
    const connection: LiveConnection = {
      scheme: "bearer",
      schemeConfig: {},
      credential: { token: TOKEN },
    };
    const bounded: StockWorkspaceTool = {
      ...tool,
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["limit"],
        additionalProperties: false,
      },
      testInput: { limit: 100 },
    };
    const recorded = await recordStockProof(bounded, { connection, upstreamFetch: vendor([]) });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { limit } = recorded.recording.input as { limit: number };
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(100);
    expect(limit).not.toBe(100);
    expect(recorded.recording.exchanges[0]?.url).toBe(
      `https://api.github.com/user/repos?per_page=${limit}`,
    );

    const pinned = await recordStockProof(
      {
        ...bounded,
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 100, maximum: 100 } },
          required: ["limit"],
        },
      },
      { connection, upstreamFetch: vendor([]) },
    );
    expect(pinned).toEqual({
      ok: false,
      problems: [
        "stock tool github__list-repos: the scrub failed: no placeholder the tool's input schema admits could be drawn for one of its values, in the input; nothing was recorded",
      ],
    });
  });

  it("does not scrub the first run's result, which the second run's replaces", async () => {
    // Every one-digit negative number: the scrub could draw no placeholder for any of them.
    const ranked: StockWorkspaceTool = {
      ...tool,
      name: "ranked",
      files: [
        {
          path: "index.ts",
          content: `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(\`/user/repos?per_page=\${input.limit}\`);
  const repos = (await res.json()) as { name: string }[];
  return { first: repos[0]?.name, ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => -n) };
};
`,
        },
      ],
    };
    const recorded = await recordStockProof(ranked, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: vendor([]),
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    expect(recorded.recording.result).toMatchObject({
      ranks: [-1, -2, -3, -4, -5, -6, -7, -8, -9],
    });
    expect((recorded.recording.result as { first: string }).first).not.toBe("graft");
  });

  it("records a search the reviewed table admits as a read, its body over the scrubbed input (GRA-270)", async () => {
    const SEARCH = `export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch("/api/v1/contacts/search", {
    host: "api.apollo.io",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q_keywords: input.query, per_page: 2 }),
  });
  if (!res.ok) throw new Error(\`POST /api/v1/contacts/search \${res.status}\`);
  const body = (await res.json()) as { contacts: { id: string; name: string }[] };
  return { names: body.contacts.map((contact) => contact.name) };
};
`;
    const search: StockWorkspaceTool = {
      ...tool,
      vendor: "apollo",
      name: "search-contacts",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      hosts: ["api.apollo.io"],
      testInput: { query: "Acme Holdings" },
      annotations: { readOnly: true, destructive: false },
      files: [{ path: "index.ts", content: SEARCH }],
    };
    const seen: UpstreamRequest[] = [];
    const recorded = await recordStockProof(search, {
      connection: {
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-api-key" },
        credential: { apiKey: TOKEN },
      },
      upstreamFetch: async (request) => {
        seen.push(request);
        return Response.json({
          contacts: [
            { id: "66e9e215ece19801b219997f", name: "Alice Liddell" },
            { id: "66e9e215ece19801b2199980", name: "Bruce Wayne" },
          ],
        });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { recording } = recorded;

    // The search reached the vendor once, as a read, and is recorded as one with its body.
    expect(seen.map((request) => request.method)).toEqual(["POST"]);
    const [read] = recording.exchanges;
    expect(read).toMatchObject({
      kind: "read",
      method: "POST",
      url: "https://api.apollo.io/api/v1/contacts/search",
      response: { status: 200 },
    });
    // The body is the second run's, over the scrubbed input: the query is the placeholder.
    const query = recording.input.query as string;
    expect(query).not.toBe("Acme Holdings");
    expect(read).toMatchObject({ body: { json: { q_keywords: query, per_page: 2 } } });
    const text = JSON.stringify(recording);
    for (const planted of ["Acme Holdings", "Alice Liddell", "Bruce Wayne", TOKEN]) {
      expect(text).not.toContain(planted);
    }

    const replay = await proveReplay({ ...search, testInput: recording.input }, recording);
    expect(replay.problems).toEqual([]);
    expect(replay.reachedVendor).toMatchObject([{ method: "POST" }]);
  });

  it("records a GraphQL query as a read with its body, scrubbed, and replays it by the body (GRA-260)", async () => {
    const GRAPHQL = `const VIEWER = "query Viewer { viewer { id name } }";
const ISSUES = "query Issues($assignee: ID!, $first: Int!) { issues(filter: { assignee: { id: { eq: $assignee } } }, first: $first) { nodes { title } } }";
const COMMENT = "mutation Comment($body: String!) { commentCreate(input: { body: $body }) { success } }";

export default async (input: Input, ctx: Context) => {
  const post = (body: unknown) =>
    ctx.fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const me = (await (await post({ query: VIEWER })).json()) as {
    data: { viewer: { id: string; name: string } };
  };
  const res = await post({
    query: ISSUES,
    variables: { assignee: me.data.viewer.id, first: input.first },
  });
  const issues = (await res.json()) as { data: { issues: { nodes: { title: string }[] } } };
  const titles = issues.data.issues.nodes.map((node) => node.title);
  const noted = await post({ query: COMMENT, variables: { body: titles[0] ?? "none" } });
  return { who: me.data.viewer.name, titles, noted: noted.status };
};
`;
    const graphqlTool: StockWorkspaceTool = {
      ...tool,
      name: "graphql-issues",
      inputSchema: {
        type: "object",
        properties: { first: { type: "integer", minimum: 1, maximum: 50 } },
        required: ["first"],
        additionalProperties: false,
      },
      testInput: { first: 5 },
      files: [{ path: "index.ts", content: GRAPHQL }],
    };
    const seen: { method: string; body: unknown }[] = [];
    const recorded = await recordStockProof(graphqlTool, {
      connection: { scheme: "bearer", schemeConfig: {}, credential: { token: TOKEN } },
      upstreamFetch: async (request: UpstreamRequest) => {
        const body = JSON.parse(new TextDecoder().decode(request.body ?? new Uint8Array()));
        seen.push({ method: request.method, body });
        if (String(body.query).startsWith("query Viewer")) {
          return Response.json({ data: { viewer: { id: "usr-7f3a9c21", name: "Alice Liddell" } } });
        }
        return Response.json({
          data: { issues: { nodes: [{ title: "Acme secret merger plans" }] } },
        });
      },
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("\n"));
    const { recording } = recorded;

    // The two queries reached the vendor; the mutation stopped at the preview.
    expect(seen.map((request) => request.method)).toEqual(["POST", "POST"]);
    expect(recording.exchanges.map((exchange) => `${exchange.kind} ${exchange.method}`)).toEqual([
      "read POST",
      "read POST",
      "write POST",
    ]);
    const text = JSON.stringify(recording);
    for (const planted of ["usr-7f3a9c21", "Alice Liddell", "Acme secret merger plans"]) {
      expect(text).not.toContain(planted);
    }
    // The second query names the scrubbed viewer's id, as the module computed it over the scrub.
    const [viewer, issues] = recording.exchanges;
    const scrubbedId = (
      viewer as { response: { body: { json: { data: { viewer: { id: string } } } } } }
    ).response.body.json.data.viewer.id;
    expect(issues).toMatchObject({
      body: { json: { variables: { assignee: scrubbedId, first: 5 } } },
    });

    const replay = await proveReplay(graphqlTool, recording);
    expect(replay.problems).toEqual([]);
    expect(replay.reachedVendor.map((request) => request.method)).toEqual(["POST", "POST"]);

    // A replay whose module asks another query than the recording's is refused by the body.
    const changed = await proveReplay(
      {
        ...graphqlTool,
        files: [
          {
            path: "index.ts",
            content: GRAPHQL.replace("viewer { id name }", "viewer { id name email }"),
          },
        ],
      },
      recording,
    );
    expect(changed.problems.join("\n")).toContain("its read 1 disagrees with the recording");
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
