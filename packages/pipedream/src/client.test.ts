import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECT_TOKEN_TTL_SECONDS,
  connectLinkUrlFor,
  createPipedreamClient,
  type PipedreamClient,
  PipedreamError,
  TOKEN_SKEW_MS,
} from "./client";
import { EXTERNAL_USER_ID_PREFIX, externalUserIdFor, personIdOf } from "./external-user-id";
import { createFakePipedreamClient } from "./fake";
import { type FakePipedream, startFakePipedream } from "./testing/fake-pipedream";

/**
 * The client against Pipedream on a loopback port (`testing/fake-pipedream.ts`), over real HTTP:
 * what each call sends and what it makes of the answer, the access token bought once and refreshed
 * with skew and single-flight, and the one thing the client must never do — read a credential. The
 * fake's own contract (the link page connects an account and sends the browser back) is pinned
 * here too, since the proof script and the server's suites stand on it.
 */

let pipedream: FakePipedream;
let clock = Date.parse("2026-09-17T10:00:00Z");
const now = () => clock;

beforeAll(async () => {
  pipedream = await startFakePipedream({ now });
});

afterAll(async () => {
  await pipedream.close();
});

beforeEach(() => {
  pipedream.seen.length = 0;
  pipedream.accounts.length = 0;
});

function client(overrides: { clientSecret?: string } = {}): PipedreamClient {
  return createPipedreamClient(
    {
      projectId: pipedream.projectId,
      environment: "development",
      clientId: pipedream.clientId,
      clientSecret: overrides.clientSecret ?? pipedream.clientSecret,
      apiOrigin: pipedream.url,
    },
    { now },
  );
}

const PERSON = "person_1";
const USER = externalUserIdFor(PERSON);

describe("the external user id", () => {
  it("is the prefix and the person's id, and reads back to the person", () => {
    expect(USER).toBe(`${EXTERNAL_USER_ID_PREFIX}person_1`);
    expect(personIdOf(USER)).toBe(PERSON);
    expect(personIdOf("someone-elses-id")).toBeNull();
    expect(personIdOf(EXTERNAL_USER_ID_PREFIX)).toBeNull();
    expect(() => externalUserIdFor("")).toThrow();
  });
});

describe("the access token", () => {
  it("is bought once with the client credentials, sent on every call, and never re-bought while it lives", async () => {
    const c = client();
    await c.listAccounts({ externalUserId: USER, app: "gmail" });
    await c.listAccounts({ externalUserId: USER, app: "gmail" });
    const tokenCalls = pipedream.seen.filter((s) => s.path === "/v1/oauth/token");
    expect(tokenCalls).toHaveLength(1);
    expect(JSON.parse(tokenCalls[0]?.body ?? "{}")).toEqual({
      grant_type: "client_credentials",
      client_id: pipedream.clientId,
      client_secret: pipedream.clientSecret,
    });
    const listCalls = pipedream.seen.filter((s) => s.path.endsWith("/accounts"));
    expect(listCalls).toHaveLength(2);
    for (const call of listCalls) {
      expect(call.headers.authorization).toBe(`Bearer ${pipedream.accessToken}`);
      expect(call.headers["x-pd-environment"]).toBe("development");
    }
  });

  it("is refreshed a minute before it expires, and a burst buys one token", async () => {
    const c = client();
    await Promise.all([
      c.relayFields({ externalUserId: USER, accountId: "apn_1" }),
      c.relayFields({ externalUserId: USER, accountId: "apn_1" }),
      c.relayFields({ externalUserId: USER, accountId: "apn_1" }),
    ]);
    expect(pipedream.seen.filter((s) => s.path === "/v1/oauth/token")).toHaveLength(1);
    clock += 3600_000 - TOKEN_SKEW_MS - 1;
    await c.relayFields({ externalUserId: USER, accountId: "apn_1" });
    expect(pipedream.seen.filter((s) => s.path === "/v1/oauth/token")).toHaveLength(1);
    clock += 2;
    await c.relayFields({ externalUserId: USER, accountId: "apn_1" });
    expect(pipedream.seen.filter((s) => s.path === "/v1/oauth/token")).toHaveLength(2);
  });

  it("a refused exchange is a PipedreamError with the status and never the body, which echoes the client id", async () => {
    const c = client({ clientSecret: "wrong" });
    const error = await c.listAccounts({ externalUserId: USER, app: "gmail" }).catch((e) => e);
    expect(error).toBeInstanceOf(PipedreamError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("client credentials");
    expect(error.message).not.toContain(pipedream.clientId);
    expect(error.message).not.toContain("invalid_client");
  });

  it("an unreachable Pipedream is a PipedreamError with no status and the cause attached", async () => {
    const c = createPipedreamClient(
      {
        projectId: "proj_x",
        environment: "production",
        clientId: "a",
        clientSecret: "b",
        apiOrigin: "http://127.0.0.1:9",
      },
      { now },
    );
    const error = await c.listAccounts({ externalUserId: USER, app: "gmail" }).catch((e) => e);
    expect(error).toBeInstanceOf(PipedreamError);
    expect(error.status).toBeNull();
    expect(error.cause).toBeDefined();
  });
});

describe("the connect token and the link", () => {
  it("mints a token for the person with both return URIs and the fifteen-minute lifetime, and preselects the app on the link", async () => {
    const c = client();
    const token = await c.createConnectToken({
      externalUserId: USER,
      app: "gmail",
      successRedirectUri: "http://graft.test/api/providers/link/callback?state=s&outcome=success",
      errorRedirectUri: "http://graft.test/api/providers/link/callback?state=s&outcome=error",
    });
    expect(token.token).toMatch(/^ctok_[0-9a-f]{32}$/);
    const link = new URL(token.connectLinkUrl);
    expect(link.searchParams.get("token")).toBe(token.token);
    expect(link.searchParams.get("connectLink")).toBe("true");
    expect(link.searchParams.get("app")).toBe("gmail");
    expect(token.expiresAt).toBe(new Date(clock + CONNECT_TOKEN_TTL_SECONDS * 1000).toISOString());
    const minted = pipedream.seen.find((s) => s.path.endsWith("/tokens"));
    expect(JSON.parse(minted?.body ?? "{}")).toEqual({
      external_user_id: USER,
      success_redirect_uri: "http://graft.test/api/providers/link/callback?state=s&outcome=success",
      error_redirect_uri: "http://graft.test/api/providers/link/callback?state=s&outcome=error",
      expires_in: CONNECT_TOKEN_TTL_SECONDS,
    });
    expect(
      connectLinkUrlFor("https://pipedream.com/_static/connect.html?token=t", "slack_v2"),
    ).toBe("https://pipedream.com/_static/connect.html?token=t&app=slack_v2");
  });

  it("the fake's link page connects an account under the token's person and app, then sends the browser to the success URI — or to the error URI on failure", async () => {
    const c = client();
    const token = await c.createConnectToken({
      externalUserId: USER,
      app: "gmail",
      successRedirectUri: "http://graft.test/return?outcome=success",
      errorRedirectUri: "http://graft.test/return?outcome=error",
    });
    const landed = await fetch(token.connectLinkUrl, { redirect: "manual" });
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("http://graft.test/return?outcome=success");
    const accounts = await c.listAccounts({ externalUserId: USER, app: "gmail" });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: expect.stringMatching(/^apn_/),
      externalUserId: USER,
      healthy: true,
      dead: false,
      app: { slug: "gmail" },
    });
    expect(accounts[0]?.name).toContain("@gmail.example");
    // Another person's accounts, or another app's, are not this person's.
    expect(await c.listAccounts({ externalUserId: externalUserIdFor("p2"), app: "gmail" })).toEqual(
      [],
    );
    expect(await c.listAccounts({ externalUserId: USER, app: "slack" })).toEqual([]);

    const again = await c.createConnectToken({
      externalUserId: USER,
      app: "gmail",
      successRedirectUri: "http://graft.test/return?outcome=success",
      errorRedirectUri: "http://graft.test/return?outcome=error",
    });
    const failed = await fetch(`${again.connectLinkUrl}&fail=1`, { redirect: "manual" });
    expect(failed.headers.get("location")).toBe("http://graft.test/return?outcome=error");
    expect(await c.listAccounts({ externalUserId: USER, app: "gmail" })).toHaveLength(1);
  });
});

describe("accounts and the relay's fields", () => {
  it("lists by person and app with no credentials asked for, deletes by id, and answers 404 as an error", async () => {
    const c = client();
    pipedream.connect({ externalUserId: USER, app: "gmail", id: "apn_a" });
    pipedream.connect({ externalUserId: USER, app: "gmail", id: "apn_b", healthy: false });
    const accounts = await c.listAccounts({ externalUserId: USER, app: "gmail" });
    expect(accounts.map((a) => [a.id, a.healthy])).toEqual([
      ["apn_a", true],
      ["apn_b", false],
    ]);
    const list = pipedream.seen.find((s) => s.path.endsWith("/accounts"));
    expect(list?.query).toEqual({ external_user_id: USER, app: "gmail" });
    expect(list?.query.include_credentials).toBeUndefined();

    await c.deleteAccount("apn_a");
    expect(pipedream.accounts.map((a) => a.id)).toEqual(["apn_b"]);
    const gone = await c.deleteAccount("apn_a").catch((e) => e);
    expect(gone).toBeInstanceOf(PipedreamError);
    expect(gone.status).toBe(404);
  });

  it("the relay's fields are Graft's token, the project, the environment, the two ids and the origin — none of them the person's", async () => {
    const c = client();
    const fields = await c.relayFields({ externalUserId: USER, accountId: "apn_a" });
    expect(fields).toEqual({
      accessToken: pipedream.accessToken,
      projectId: pipedream.projectId,
      environment: "development",
      externalUserId: USER,
      accountId: "apn_a",
      apiOrigin: pipedream.url,
    });
  });

  it("has no method that reads an account's credentials", () => {
    const c = client();
    expect(Object.keys(c).sort()).toEqual(
      [
        "apiOrigin",
        "createConnectToken",
        "deleteAccount",
        "environment",
        "listAccounts",
        "projectId",
        "relayFields",
      ].sort(),
    );
  });
});

describe("the in-memory fake", () => {
  it("mints, connects, lists, relays and deletes like the client, and fails on demand", async () => {
    const fake = createFakePipedreamClient({ now: () => new Date(clock) });
    const token = await fake.createConnectToken({
      externalUserId: USER,
      app: "gmail",
      successRedirectUri: "s",
      errorRedirectUri: "e",
    });
    expect(new URL(token.connectLinkUrl).searchParams.get("app")).toBe("gmail");
    expect(fake.tokens[0]).toMatchObject({ externalUserId: USER, app: "gmail", success: "s" });
    const account = fake.connect({ externalUserId: USER, app: "gmail", name: "a@b.example" });
    expect(await fake.listAccounts({ externalUserId: USER, app: "gmail" })).toEqual([account]);
    expect(await fake.relayFields({ externalUserId: USER, accountId: account.id })).toMatchObject({
      accountId: account.id,
      externalUserId: USER,
    });
    await fake.deleteAccount(account.id);
    expect(fake.deleted).toEqual([account.id]);
    fake.failNext();
    await expect(fake.listAccounts({ externalUserId: USER, app: "gmail" })).rejects.toBeInstanceOf(
      PipedreamError,
    );
    expect(await fake.listAccounts({ externalUserId: USER, app: "gmail" })).toEqual([]);
  });
});
