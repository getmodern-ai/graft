import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The Stripe stock modules driven directly, over a scripted `ctx.fetch`: what the recordings
 * cannot show, because a recording is one dry run (GRA-261, Greptile and CodeQL on #202). The
 * harness (`harness.test.ts`) remains the proof of each recorded run.
 */

const STRIPE_DIR = fileURLToPath(new URL("../tools/stripe/", import.meta.url));
const PINNED_VERSION = "2026-02-25.clover";

type Call = { path: string; method: string; headers: Headers; body: string | null };
type Answer = { status?: number; json?: unknown; dryRun?: boolean };
type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
type Module = (input: unknown, ctx: { fetch: Fetch }) => Promise<unknown>;

function scriptedCtx(answer: (call: Call) => Answer) {
  const calls: Call[] = [];
  const fetch: Fetch = async (path, init) => {
    const call: Call = {
      path,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? null : String(init.body),
    };
    calls.push(call);
    const { status = 200, json = {}, dryRun = false } = answer(call);
    const headers = new Headers({ "content-type": "application/json" });
    if (dryRun) headers.set("x-graft-dry-run", "intercepted");
    return new Response(JSON.stringify(json), { status: dryRun ? 202 : status, headers });
  };
  return { ctx: { fetch }, calls };
}

async function load(name: string): Promise<Module> {
  const url = pathToFileURL(`${STRIPE_DIR}${name}/index.ts`).href;
  return ((await import(url)) as { default: Module }).default;
}

const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });

describe("every Stripe stock module", () => {
  it("pins Stripe-Version on every request", async () => {
    const names = (await readdir(STRIPE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);

    const inputs: Record<string, unknown> = {
      "create-customer": { email: "a@example.com" },
      "create-invoice": {
        customer: "cus_1",
        items: [{ amount: 100, currency: "usd", description: "x" }],
        send: true,
      },
      "find-customer": { query: "Ada" },
      "refund-payment": { charge: "ch_1" },
    };
    for (const name of names) {
      const run = await load(name);
      const { ctx, calls } = scriptedCtx(() => ({
        json: { id: "x_1", created: 0, livemode: false, available: [], pending: [], data: [] },
      }));
      await run(inputs[name] ?? {}, ctx).catch(() => undefined);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.headers.get("stripe-version"), `${name} ${call.method} ${call.path}`).toBe(
          PINNED_VERSION,
        );
      }
    }
  });
});

describe("stripe__create-invoice", () => {
  it("refuses an item that names neither a price nor an amount before any write", async () => {
    const run = await load("create-invoice");
    const { ctx, calls } = scriptedCtx(() => ({ json: { id: "in_1" } }));
    await expect(
      run(
        {
          customer: "cus_1",
          items: [{ amount: 100, currency: "usd", description: "ok" }, {}],
        },
        ctx,
      ),
    ).rejects.toThrow(/Nothing was created\. Item 2 must provide/);
    expect(calls).toEqual([]);
  });

  it("refuses an item that names both a price and an amount before any write", async () => {
    const run = await load("create-invoice");
    const { ctx, calls } = scriptedCtx(() => ({ json: { id: "in_1" } }));
    await expect(
      run({ customer: "cus_1", items: [{ price: "price_1", amount: 5 }] }, ctx),
    ).rejects.toThrow(/Item 1 must use either price/);
    expect(calls).toEqual([]);
  });

  it("answers a draft's amounts as read after its items are added", async () => {
    const run = await load("create-invoice");
    const { ctx, calls } = scriptedCtx((call) => {
      if (call.method === "POST" && call.path === "/invoices") {
        return { json: { id: "in_1", status: "draft", total: 0, amount_due: 0, currency: "usd" } };
      }
      if (call.method === "POST") return { json: { id: "ii_1" } };
      return {
        json: { id: "in_1", status: "draft", total: 2500, amount_due: 2500, currency: "usd" },
      };
    });
    const result = await run(
      {
        customer: "cus_1",
        items: [
          { amount: 1000, currency: "usd", description: "a" },
          { price: "price_1", quantity: 3 },
        ],
      },
      ctx,
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /invoices",
      "POST /invoiceitems",
      "POST /invoiceitems",
      "GET /invoices/in_1",
    ]);
    expect(result).toMatchObject({ id: "in_1", total: 2500, amount_due: 2500, sent: false });
  });

  it("answers a sent invoice from the send, with no further read", async () => {
    const run = await load("create-invoice");
    const { ctx, calls } = scriptedCtx((call) => {
      if (call.path === "/invoices/in_1/send") {
        return { json: { id: "in_1", status: "open", total: 1000, amount_due: 1000 } };
      }
      return { json: { id: call.path === "/invoices" ? "in_1" : "ii_1", total: 0 } };
    });
    const result = await run(
      {
        customer: "cus_1",
        items: [{ amount: 1000, currency: "usd", description: "a" }],
        send: true,
      },
      ctx,
    );
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST"]);
    expect(result).toMatchObject({ status: "open", total: 1000, sent: true });
  });

  it("names the draft it created when Stripe refuses an item", async () => {
    const run = await load("create-invoice");
    const { ctx } = scriptedCtx((call) =>
      call.path === "/invoices"
        ? { json: { id: "in_9" } }
        : { status: 400, json: { error: { message: "No such price" } } },
    );
    await expect(
      run({ customer: "cus_1", items: [{ price: "price_missing" }] }, ctx),
    ).rejects.toThrow(/Draft invoice in_9 was created, but Stripe refused item 1/);
  });
});

describe("stripe__find-customer", () => {
  it("escapes a backslash and a quote inside the search value", async () => {
    const run = await load("find-customer");
    const { ctx, calls } = scriptedCtx(() => ({ json: list([]) }));
    await run({ query: 'a\\" OR name~"b' }, ctx);
    const query = new URL(`https://x${calls[0]?.path}`).searchParams.get("query");
    expect(query).toBe('name~"a\\\\\\" OR name~\\"b"');
  });

  it("pages a name search by Stripe's next_page and an email lookup by the last id", async () => {
    const run = await load("find-customer");
    const customer = { id: "cus_2", created: 0, balance: 0 };

    const search = scriptedCtx(() => ({ json: { ...list([customer], true), next_page: "pg_2" } }));
    expect(await run({ query: "Ada", cursor: "pg_1" }, search.ctx)).toMatchObject({
      hasMore: true,
      nextCursor: "pg_2",
    });
    expect(new URL(`https://x${search.calls[0]?.path}`).searchParams.get("page")).toBe("pg_1");

    const email = scriptedCtx(() => ({ json: list([customer], true) }));
    expect(await run({ query: "a@example.com", cursor: "cus_1" }, email.ctx)).toMatchObject({
      nextCursor: "cus_2",
    });
    expect(new URL(`https://x${email.calls[0]?.path}`).searchParams.get("starting_after")).toBe(
      "cus_1",
    );
  });
});

describe("the Stripe list tools", () => {
  const cases: Array<{ name: string; item: unknown; cursor: string }> = [
    { name: "list-payments", item: { id: "ch_2", created: 0 }, cursor: "ch_2" },
    { name: "list-invoices", item: { id: "in_2" }, cursor: "in_2" },
    { name: "list-subscriptions", item: { id: "sub_2" }, cursor: "sub_2" },
    {
      name: "list-products",
      item: { id: "price_2", type: "one_time", product: { id: "prod_1", name: "p" } },
      cursor: "price_2",
    },
  ];

  for (const { name, item, cursor } of cases) {
    it(`${name} reads the page after a cursor and answers the next one`, async () => {
      const run = await load(name);
      const more = scriptedCtx(() => ({ json: list([item], true) }));
      expect(await run({ cursor: "x_1" }, more.ctx)).toMatchObject({
        hasMore: true,
        nextCursor: cursor,
      });
      const sent = new URL(`https://x${more.calls[0]?.path}`).searchParams;
      expect(sent.get("starting_after")).toBe("x_1");

      const last = scriptedCtx(() => ({ json: list([item], false) }));
      expect(await run({}, last.ctx)).toMatchObject({ hasMore: false, nextCursor: null });
    });
  }
});

describe("stripe__get-customer", () => {
  it("says when the expanded subscriptions are one page of more", async () => {
    const run = await load("get-customer");
    const { ctx } = scriptedCtx(() => ({
      json: { id: "cus_1", subscriptions: list([{ id: "sub_1" }], true) },
    }));
    expect(await run({ customer: "cus_1" }, ctx)).toMatchObject({ subscriptionsHasMore: true });
  });
});

describe("stripe__get-invoice", () => {
  it("sums total_taxes, and reads tax where an older response carries it", async () => {
    const run = await load("get-invoice");
    const itemised = scriptedCtx(() => ({
      json: { id: "in_1", total_taxes: [{ amount: 120 }, { amount: 30 }] },
    }));
    expect(await run({ invoice: "in_1" }, itemised.ctx)).toMatchObject({ tax: 150 });

    const older = scriptedCtx(() => ({ json: { id: "in_1", tax: 75 } }));
    expect(await run({ invoice: "in_1" }, older.ctx)).toMatchObject({ tax: 75 });
  });
});
