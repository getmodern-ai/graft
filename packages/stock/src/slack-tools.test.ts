import { join } from "node:path";

import { starterVendorFor } from "@graft/core";
import { describe, expect, it } from "vitest";

import { readStockWorkspace, STOCK_DIR } from "./workspace";

/**
 * Slack's stock tools (GRA-251) beyond what a recording replays: the scopes the Slack starter's
 * consent asks for against the methods the modules call, and the answers a dry run's recording
 * never holds (Greptile on #195).
 */

/** The bot scope each Slack method a stock tool calls needs (docs.slack.dev, each method's page). */
const METHOD_SCOPES: Record<string, readonly string[]> = {
  "conversations.list": ["channels:read", "groups:read"],
  "conversations.history": ["channels:history", "groups:history"],
  "conversations.replies": ["channels:history", "groups:history"],
  "users.list": ["users:read"],
  "users.info": ["users:read"],
  "users.lookupByEmail": ["users:read.email"],
  "chat.postMessage": ["chat:write"],
  "reactions.add": ["reactions:write"],
};

describe("the Slack starter's consent", () => {
  it("asks for every scope the methods of Slack's stock tools need", async () => {
    const scopes = new Set(
      (starterVendorFor("slack")?.schemeConfig.scopes ?? "").split(",").filter(Boolean),
    );
    const tools = (await readStockWorkspace()).filter((tool) => tool.vendor === "slack");
    expect(tools.length).toBeGreaterThan(0);
    const unknown: string[] = [];
    const missing: string[] = [];
    for (const tool of tools) {
      const source = tool.files.map((file) => file.content).join("\n");
      for (const [, method] of source.matchAll(/["`]\/([a-z]+\.[a-zA-Z]+)[?"`]/g)) {
        if (!method) continue;
        const needed = METHOD_SCOPES[method];
        if (!needed) unknown.push(`${tool.name} calls ${method}`);
        for (const scope of needed ?? []) {
          if (!scopes.has(scope)) missing.push(`${tool.name}'s ${method} needs ${scope}`);
        }
      }
    }
    expect(unknown).toEqual([]);
    expect(missing).toEqual([]);
  });
});

type Answer = { status: number; body: unknown };
type Module = (input: unknown, ctx: unknown) => Promise<unknown>;

/** A tool's module, loaded by a path the type program never follows (`tools/` is not in it). */
async function slackModule(name: string): Promise<Module> {
  const path: string = join(STOCK_DIR, "slack", name, "index.ts");
  return ((await import(path)) as { default: Module }).default;
}

/** A `ctx` whose fetch answers by the Slack method in the path, recording the paths asked. */
function fakeContext(answers: Record<string, Answer>) {
  const asked: string[] = [];
  return {
    asked,
    ctx: {
      fetch: async (path: string) => {
        asked.push(path);
        const method = path.slice(1).split("?")[0] ?? "";
        const answer = answers[method];
        if (!answer) throw new Error(`no answer for ${path}`);
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

const CHANNELS: Answer = {
  status: 200,
  body: { ok: true, channels: [{ id: "C0001", name: "general" }], response_metadata: {} },
};

describe("reply-in-thread", () => {
  const input = { channel: "general", threadTs: "1.000", text: "hello" };

  it("fails when the proxy refuses the post, rather than reading it as a preview", async () => {
    const reply = await slackModule("reply-in-thread");
    const { ctx } = fakeContext({
      "conversations.list": CHANNELS,
      "chat.postMessage": {
        status: 502,
        body: {
          error: "upstream_failed",
          reason: "fetch_failed",
          message: "Slack was not reached",
        },
      },
    });
    await expect(reply(input, ctx)).rejects.toThrow(/chat\.postMessage 502/);
  });

  it("answers the preview's status on a dry run", async () => {
    const reply = await slackModule("reply-in-thread");
    const { ctx } = fakeContext({
      "conversations.list": CHANNELS,
      "chat.postMessage": { status: 202, body: { preview: true } },
    });
    expect(await reply(input, ctx)).toEqual({
      channel: "C0001",
      threadTs: "1.000",
      previewStatus: 202,
    });
  });
});

describe("read-thread", () => {
  const message = { ts: "1.000", user: "U0000001", text: "first" };

  it("says a thread goes on, with the cursor that reads its next page", async () => {
    const read = await slackModule("read-thread");
    const { ctx, asked } = fakeContext({
      "conversations.list": CHANNELS,
      "conversations.replies": {
        status: 200,
        body: {
          ok: true,
          messages: [message],
          has_more: true,
          response_metadata: { next_cursor: "bmV4dA==" },
        },
      },
    });
    const result = await read({ channel: "general", threadTs: "1.000", cursor: "Zmlyc3Q=" }, ctx);
    expect(result).toMatchObject({ hasMore: true, nextCursor: "bmV4dA==" });
    expect(asked.at(-1)).toContain("cursor=Zmlyc3Q%3D");
  });

  it("says a thread read whole is complete", async () => {
    const read = await slackModule("read-thread");
    const { ctx, asked } = fakeContext({
      "conversations.list": CHANNELS,
      "conversations.replies": { status: 200, body: { ok: true, messages: [message] } },
    });
    const result = await read({ channel: "general", threadTs: "1.000" }, ctx);
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
    expect(asked.at(-1)).not.toContain("cursor=");
  });
});

describe("find-user", () => {
  it("looks a user id up, as a message's author", async () => {
    const find = await slackModule("find-user");
    const { ctx, asked } = fakeContext({
      "users.info": {
        status: 200,
        body: { ok: true, user: { id: "U0123ABCD", name: "sam", real_name: "Sam Example" } },
      },
    });
    const result = (await find({ query: "U0123ABCD" }, ctx)) as { matches: { id: string }[] };
    expect(result.matches.map((match) => match.id)).toEqual(["U0123ABCD"]);
    expect(asked).toEqual(["/users.info?user=U0123ABCD"]);
  });

  it("searches names when Slack knows no user by that id: a name in capitals looks like one", async () => {
    const find = await slackModule("find-user");
    const { ctx, asked } = fakeContext({
      "users.info": { status: 200, body: { ok: false, error: "user_not_found" } },
      "users.list": {
        status: 200,
        body: {
          ok: true,
          members: [{ id: "U0999ZZZZ", name: "william", real_name: "William Example" }],
          response_metadata: { next_cursor: "" },
        },
      },
    });
    const result = (await find({ query: "WILLIAM" }, ctx)) as { matches: { id: string }[] };
    expect(result.matches.map((match) => match.id)).toEqual(["U0999ZZZZ"]);
    expect(asked).toEqual(["/users.info?user=WILLIAM", "/users.list?limit=200"]);
  });
});
