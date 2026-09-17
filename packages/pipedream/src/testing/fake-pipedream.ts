import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { decodePipedreamProxySegment } from "@graft/proxy/pipedream-relay";

/**
 * Pipedream on a loopback port (GRA-59): enough of the Connect API for the client, the link flow
 * and the relay to run end to end with nothing leaving the machine. The token endpoint checks the
 * client credentials and issues an access token; the connect-token endpoint mints a `ctok_` and
 * remembers the redirect URIs; the Connect Link page — what the console opens — connects an account
 * under the token's external user id and app and sends the browser to the success URI (or to the
 * error URI when opened with `&fail=1`), which is what Pipedream's hosted page does once the
 * vendor's consent lands; the accounts endpoint lists and deletes; and the proxy decodes the vendor
 * URL out of its path, checks the two ids name an account this fake holds, and hands the request to
 * the vendor handler the test supplies. Every request is recorded on `seen`.
 *
 * `apps/server`'s proof script runs the real server against this, and `client.test.ts` drives the
 * client through it over real HTTP.
 */

export type FakePipedreamAccount = {
  id: string;
  name: string | null;
  externalUserId: string;
  app: string;
  healthy: boolean;
  createdAt: string;
};

export type FakePipedreamSeen = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  /** For a proxy call: the vendor URL decoded from the path. */
  vendorUrl: string | null;
};

/** A vendor request as the fake proxy forwards it to the handler the test supplies. */
export type FakeVendorRequest = {
  method: string;
  url: URL;
  /** The caller's headers as Pipedream would forward them: the `x-pd-proxy-` prefix stripped. */
  headers: Headers;
  body: string;
  account: FakePipedreamAccount;
};

export type FakePipedream = {
  url: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  accounts: FakePipedreamAccount[];
  seen: FakePipedreamSeen[];
  /** The connect tokens minted, keyed by token, with what the caller asked for. */
  tokens: Map<
    string,
    {
      externalUserId: string;
      app: string | null;
      success: string;
      error: string;
      expiresAt: number;
    }
  >;
  /** Connect an account under a person without the browser — what the link page does on open. */
  connect(args: {
    externalUserId: string;
    app: string;
    id?: string;
    name?: string | null;
    healthy?: boolean;
  }): FakePipedreamAccount;
  close(): Promise<void>;
};

export type StartFakePipedreamOptions = {
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  /** Seconds the access token claims to live. */
  accessTokenTtlSeconds?: number;
  /** What the vendor answers a relayed request; the default is a small Gmail-shaped JSON body. */
  vendor?: (request: FakeVendorRequest) => Response | Promise<Response>;
  /** The name the link page gives a connected account; the default is a Gmail-shaped address. */
  accountName?: (externalUserId: string, app: string) => string;
  now?: () => number;
};

const PROXY_PREFIX = "x-pd-proxy-";

export async function startFakePipedream(
  options: StartFakePipedreamOptions = {},
): Promise<FakePipedream> {
  const projectId = options.projectId ?? "proj_fake";
  const clientId = options.clientId ?? "pd_client_fake";
  const clientSecret = options.clientSecret ?? "pd_secret_fake";
  const accessToken = options.accessToken ?? "pd_access_fake";
  const now = options.now ?? Date.now;
  const vendor =
    options.vendor ??
    (() => Response.json({ messages: [{ id: "18f1", threadId: "18f1" }], resultSizeEstimate: 1 }));
  const accountName =
    options.accountName ?? ((externalUserId, app) => `${externalUserId}@${app}.example`);
  const accounts: FakePipedreamAccount[] = [];
  const seen: FakePipedreamSeen[] = [];
  const tokens: FakePipedream["tokens"] = new Map();
  let counter = 0;

  const connect: FakePipedream["connect"] = (args) => {
    const account: FakePipedreamAccount = {
      id: args.id ?? `apn_fake_${++counter}`,
      name: args.name === undefined ? accountName(args.externalUserId, args.app) : args.name,
      externalUserId: args.externalUserId,
      app: args.app,
      healthy: args.healthy ?? true,
      createdAt: new Date(now()).toISOString(),
    };
    accounts.push(account);
    return account;
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const listed = (account: FakePipedreamAccount) => ({
    id: account.id,
    name: account.name,
    external_id: account.externalUserId,
    healthy: account.healthy,
    dead: false,
    app: { name: account.app, name_slug: account.app },
    created_at: account.createdAt,
    updated_at: account.createdAt,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://pipedream.fake");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      const proxyMatch = /^\/v1\/connect\/([^/]+)\/proxy\/([^/]+)$/.exec(url.pathname);
      const record: FakePipedreamSeen = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
        vendorUrl: proxyMatch?.[2]
          ? (decodePipedreamProxySegment(proxyMatch[2])?.href ?? null)
          : null,
      };
      seen.push(record);

      // The token endpoint: client credentials in, an access token out.
      if (method === "POST" && url.pathname === "/v1/oauth/token") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return json(res, 400, { error: "invalid_request" });
        }
        if (parsed.client_id !== clientId || parsed.client_secret !== clientSecret) {
          return json(res, 401, { error: "invalid_client", client_id: parsed.client_id });
        }
        return json(res, 200, {
          access_token: accessToken,
          token_type: "bearer",
          expires_in: options.accessTokenTtlSeconds ?? 3600,
        });
      }

      // The Connect Link page — the browser lands here from the console's popup.
      if (method === "GET" && url.pathname === "/_static/connect.html") {
        const token = tokens.get(url.searchParams.get("token") ?? "");
        if (!token || token.expiresAt <= now()) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("This connect token is invalid or has expired (fake Pipedream)");
        }
        const app = url.searchParams.get("app") ?? token.app;
        if (!app) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("No app was named (fake Pipedream)");
        }
        if (url.searchParams.get("fail") === "1") {
          res.writeHead(302, { location: token.error });
          return res.end();
        }
        connect({ externalUserId: token.externalUserId, app });
        tokens.delete(url.searchParams.get("token") ?? "");
        res.writeHead(302, { location: token.success });
        return res.end();
      }

      // Everything below is a Connect API call and needs Graft's access token and the project.
      if (headers.authorization !== `Bearer ${accessToken}`) {
        return json(res, 401, { error: "Unauthorized" });
      }
      const projectMatch = /^\/v1\/connect\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!projectMatch || projectMatch[1] !== projectId) {
        return json(res, 404, { error: "project not found" });
      }
      const rest = projectMatch[2] ?? "";

      if (method === "POST" && rest === "/tokens") {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        if (typeof parsed.external_user_id !== "string") {
          return json(res, 400, { error: "external_user_id is required" });
        }
        const ttl = typeof parsed.expires_in === "number" ? parsed.expires_in : 14_400;
        const token = `ctok_${(++counter).toString(16).padStart(32, "0")}`;
        const expiresAt = now() + ttl * 1000;
        tokens.set(token, {
          externalUserId: parsed.external_user_id,
          app: null,
          success:
            typeof parsed.success_redirect_uri === "string" ? parsed.success_redirect_uri : "",
          error: typeof parsed.error_redirect_uri === "string" ? parsed.error_redirect_uri : "",
          expiresAt,
        });
        return json(res, 200, {
          token,
          expires_at: new Date(expiresAt).toISOString(),
          connect_link_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/_static/connect.html?token=${token}&connectLink=true`,
        });
      }

      if (method === "GET" && rest === "/accounts") {
        const externalUserId = url.searchParams.get("external_user_id");
        const app = url.searchParams.get("app");
        const data = accounts
          .filter((a) => !externalUserId || a.externalUserId === externalUserId)
          .filter((a) => !app || a.app === app)
          .map(listed);
        return json(res, 200, {
          data,
          page_info: { count: data.length, total_count: data.length },
        });
      }

      const accountMatch = /^\/accounts\/([^/]+)$/.exec(rest);
      if (method === "DELETE" && accountMatch) {
        const index = accounts.findIndex((a) => a.id === decodeURIComponent(accountMatch[1] ?? ""));
        if (index === -1) return json(res, 404, { error: "account not found" });
        accounts.splice(index, 1);
        res.writeHead(204);
        return res.end();
      }

      if (proxyMatch) {
        const vendorUrl = proxyMatch[2] ? decodePipedreamProxySegment(proxyMatch[2]) : null;
        if (!vendorUrl) return json(res, 400, { error: "bad proxy url" });
        if (headers["x-pd-environment"] === undefined) {
          return json(res, 400, { error: "x-pd-environment is required" });
        }
        const externalUserId = url.searchParams.get("external_user_id");
        const accountId = url.searchParams.get("account_id");
        const account = accounts.find(
          (a) => a.id === accountId && a.externalUserId === externalUserId,
        );
        if (!account) return json(res, 404, { error: "account not found for this user" });
        // Pipedream's own discipline: a restricted header under the prefix is refused outright.
        for (const name of Object.keys(headers)) {
          if (!name.startsWith(PROXY_PREFIX)) continue;
          const inner = name.slice(PROXY_PREFIX.length);
          if (
            inner === "user-agent" ||
            inner === "cookie" ||
            inner === "host" ||
            inner.startsWith("sec-") ||
            inner.startsWith("proxy-")
          ) {
            return json(res, 400, { error: "Unsupported header" });
          }
        }
        const forwarded = new Headers();
        for (const [name, value] of Object.entries(headers)) {
          if (name.startsWith(PROXY_PREFIX)) forwarded.set(name.slice(PROXY_PREFIX.length), value);
          else if (name === "content-type" || name === "accept") forwarded.set(name, value);
        }
        const answer = await vendor({ method, url: vendorUrl, headers: forwarded, body, account });
        const out: Record<string, string> = {};
        answer.headers.forEach((value, name) => {
          out[name] = value;
        });
        res.writeHead(answer.status, { ...out, "x-pd-request-id": `pd_${seen.length}` });
        return res.end(Buffer.from(await answer.arrayBuffer()));
      }

      return json(res, 404, { error: "not found (fake Pipedream)" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    projectId,
    clientId,
    clientSecret,
    accessToken,
    accounts,
    seen,
    tokens,
    connect,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export type { Server };
