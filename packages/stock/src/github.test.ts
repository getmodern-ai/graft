import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { proveReplay } from "./harness";
import type { RecordedRead, StockRecording } from "./recording";
import { readStockWorkspace, STOCK_DIR, type StockWorkspaceTool } from "./workspace";

/**
 * GitHub's stock tools past what their recordings reach (GRA-253, after Greptile on #196): the
 * paging a recording of one small page never exercises, replayed through the harness over
 * hand-written exchanges, and the answer a write reads once GitHub has made the change, which a
 * recording stops short of at the preview, run against a fake `ctx.fetch`.
 */

const workspace = await readStockWorkspace();

function github(name: string, testInput: Record<string, unknown>): StockWorkspaceTool {
  const tool = workspace.find((entry) => entry.vendor === "github" && entry.name === name);
  if (!tool) throw new Error(`no github__${name} in the stock workspace`);
  return { ...tool, testInput };
}

function read(url: string, json: unknown, link?: string): RecordedRead {
  return {
    kind: "read",
    method: "GET",
    url,
    response: {
      status: 200,
      headers: { "content-type": "application/json", ...(link ? { link } : {}) },
      body: { json },
    },
  };
}

function recording(
  tool: StockWorkspaceTool,
  exchanges: RecordedRead[],
  result?: unknown,
): StockRecording {
  return {
    format: 1,
    tool: `github__${tool.name}`,
    recordedAt: "2026-10-10T00:00:00Z",
    input: tool.testInput as Record<string, unknown>,
    exchanges,
    ...(result === undefined ? {} : { result }),
  };
}

const API = "https://api.github.com";
const NEXT = `<${API}/repositories/1/issues?page=2>; rel="next", <${API}/repositories/1/issues?page=4>; rel="last"`;

const issue = {
  number: 7,
  title: "Fix the docs",
  state: "open",
  user: { login: "octocat" },
  labels: [{ name: "docs" }, "bug"],
  assignees: [{ login: "hubot" }],
  comments: 2,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  html_url: "https://github.com/octo/repo/issues/7",
};
const pullAsIssue = { number: 8, title: "A pull request", pull_request: { url: API } };

describe("github__list-issues", () => {
  const tool = github("list-issues", { owner: "octo", repo: "repo", perPage: 2, page: 1 });
  const url = `${API}/repos/octo/repo/issues?state=open&per_page=2&page=1`;

  it("answers the issues alone, with their fields, and the next page GitHub's link names", async () => {
    const report = await proveReplay(
      tool,
      recording(tool, [read(url, [pullAsIssue, issue], NEXT)], {
        nextPage: 2,
        issues: [
          {
            number: 7,
            title: "Fix the docs",
            state: "open",
            user: "octocat",
            labels: ["docs", "bug"],
            assignees: ["hubot"],
            comments: 2,
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            html_url: "https://github.com/octo/repo/issues/7",
          },
        ],
      }),
    );
    expect(report.problems).toEqual([]);
  });

  it("says a page that pull requests filled is not the end", async () => {
    const report = await proveReplay(
      tool,
      recording(tool, [read(url, [pullAsIssue, pullAsIssue], NEXT)], {
        nextPage: 2,
        issues: [],
      }),
    );
    expect(report.problems).toEqual([]);
  });

  it("answers no next page on the last one", async () => {
    const last = `<${API}/repositories/1/issues?page=1>; rel="prev", <${API}/repositories/1/issues?page=1>; rel="first"`;
    const report = await proveReplay(
      tool,
      recording(tool, [read(url, [pullAsIssue], last)], { nextPage: null, issues: [] }),
    );
    expect(report.problems).toEqual([]);
  });
});

describe("github__get-pull-request", () => {
  const tool = github("get-pull-request", { owner: "octo", repo: "repo", pullNumber: 3 });
  const pullUrl = `${API}/repos/octo/repo/pulls/3`;
  const filesUrl = `${pullUrl}/files?per_page=100`;
  const file = (filename: string) => ({
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
  });
  const page1 = Array.from({ length: 100 }, (_, index) => file(`src/${index}.ts`));
  const page2 = [file("README.md")];
  const PULL_FIELDS = [
    "title",
    "state",
    "draft",
    "merged",
    "mergeable_state",
    "body",
    "user",
    "head",
    "base",
    "commits",
    "additions",
    "deletions",
    "created_at",
    "updated_at",
    "merged_at",
    "html_url",
  ];

  it("follows every page of the changed files while GitHub's link names a next one", async () => {
    const report = await proveReplay(
      tool,
      recording(
        tool,
        [
          read(pullUrl, { number: 3, changed_files: 101 }),
          read(filesUrl, page1, `<${API}/repositories/1/pulls/3/files?page=2>; rel="next"`),
          read(
            `${filesUrl}&page=2`,
            page2,
            `<${API}/repositories/1/pulls/3/files?page=1>; rel="prev"`,
          ),
        ],
        {
          ...Object.fromEntries(PULL_FIELDS.map((field) => [field, null])),
          number: 3,
          changed_files: 101,
          labels: [],
          requested_reviewers: [],
          files: [...page1, ...page2],
        },
      ),
    );
    expect(report.problems).toEqual([]);
    expect(report.reachedVendor.map((call) => call.url)).toEqual([
      pullUrl,
      filesUrl,
      `${filesUrl}&page=2`,
    ]);
  });
});

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
type Module = { default: (input: unknown, ctx: { fetch: Fetch }) => Promise<unknown> };

// Imported by a computed path: the modules are typed against the sandbox's ambient `Input` and
// `Context`, which this package's program does not declare.
async function githubModule(name: string): Promise<Module> {
  return (await import(join(STOCK_DIR, "github", name, "index.ts"))) as Module;
}

function answering(status: number, json: unknown) {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const fetch: Fetch = async (path, init) => {
    calls.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { ctx: { fetch }, calls };
}

describe("GitHub's write tools, once GitHub has made the change", () => {
  it("github__create-issue answers the created issue", async () => {
    const { ctx, calls } = answering(201, {
      number: 12,
      title: "Broken link",
      state: "open",
      html_url: "https://github.com/octo/repo/issues/12",
    });
    const result = await (await githubModule("create-issue")).default(
      { owner: "octo", repo: "repo", title: "Broken link", labels: ["docs"] },
      ctx,
    );
    expect(calls).toEqual([
      {
        path: "/repos/octo/repo/issues",
        method: "POST",
        body: { title: "Broken link", labels: ["docs"] },
      },
    ]);
    expect(result).toEqual({
      created: true,
      number: 12,
      title: "Broken link",
      state: "open",
      html_url: "https://github.com/octo/repo/issues/12",
    });
  });

  it("github__create-pull-request answers the opened pull request", async () => {
    const { ctx, calls } = answering(201, {
      number: 13,
      title: "Add a test",
      state: "open",
      draft: true,
      html_url: "https://github.com/octo/repo/pull/13",
    });
    const result = await (await githubModule("create-pull-request")).default(
      {
        owner: "octo",
        repo: "repo",
        title: "Add a test",
        head: "feature",
        base: "main",
        draft: true,
      },
      ctx,
    );
    expect(calls[0]).toEqual({
      path: "/repos/octo/repo/pulls",
      method: "POST",
      body: { title: "Add a test", head: "feature", base: "main", draft: true },
    });
    expect(result).toEqual({
      created: true,
      number: 13,
      title: "Add a test",
      state: "open",
      draft: true,
      html_url: "https://github.com/octo/repo/pull/13",
    });
  });

  it("github__comment-on-issue-or-pull-request answers the comment", async () => {
    const { ctx, calls } = answering(201, {
      id: 99,
      html_url: "https://github.com/octo/repo/issues/7#issuecomment-99",
      created_at: "2026-10-10T00:00:00Z",
    });
    const result = await (await githubModule("comment-on-issue-or-pull-request")).default(
      { owner: "octo", repo: "repo", issueNumber: 7, body: "Looks good" },
      ctx,
    );
    expect(calls[0]).toEqual({
      path: "/repos/octo/repo/issues/7/comments",
      method: "POST",
      body: { body: "Looks good" },
    });
    expect(result).toEqual({
      created: true,
      id: 99,
      html_url: "https://github.com/octo/repo/issues/7#issuecomment-99",
      created_at: "2026-10-10T00:00:00Z",
    });
  });

  it("github__comment-on-issue-or-pull-request refuses an answer that is not a comment", async () => {
    const { ctx } = answering(201, { message: "odd" });
    await expect(
      (await githubModule("comment-on-issue-or-pull-request")).default(
        { owner: "octo", repo: "repo", issueNumber: 7, body: "Looks good" },
        ctx,
      ),
    ).rejects.toThrow("invalid comment response");
  });

  it("github__update-issue answers the issue as it now stands", async () => {
    const { ctx, calls } = answering(200, {
      number: 7,
      title: "Fix the docs",
      state: "closed",
      state_reason: "completed",
      labels: [{ name: "docs" }],
      assignees: [{ login: "hubot" }],
      html_url: "https://github.com/octo/repo/issues/7",
    });
    const result = await (await githubModule("update-issue")).default(
      { owner: "octo", repo: "repo", issueNumber: 7, state: "closed", stateReason: "completed" },
      ctx,
    );
    expect(calls[0]).toEqual({
      path: "/repos/octo/repo/issues/7",
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
    });
    expect(result).toEqual({
      updated: true,
      number: 7,
      title: "Fix the docs",
      state: "closed",
      state_reason: "completed",
      labels: ["docs"],
      assignees: ["hubot"],
      html_url: "https://github.com/octo/repo/issues/7",
    });
  });

  it("a write GitHub refuses throws with the status and GitHub's answer", async () => {
    const { ctx } = answering(422, { message: "Validation Failed" });
    await expect(
      (await githubModule("create-issue")).default(
        { owner: "octo", repo: "repo", title: "Broken link" },
        ctx,
      ),
    ).rejects.toThrow("POST /repos/octo/repo/issues 422");
  });
});
