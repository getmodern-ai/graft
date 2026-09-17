import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createAuth } from "@graft/auth";
import {
  createAgent,
  createConnectionDeps,
  createModelKeyDeps,
  createPipedreamProvider,
  defaultAgentDeps,
  defaultApprovalDeps,
  defaultLedgerDeps,
  defaultMcpOAuthDeps,
  defaultPendingActionDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  keyringProvider,
  oauthRedirectUri,
  protectedResourceMetadataUrl,
} from "@graft/core";
import { createDb } from "@graft/db";
import { applyMigrations } from "@graft/db/migrate";
import { user } from "@graft/db/schema/auth";
import { createMcpDeps } from "@graft/mcp";
import { generateTestKeys } from "@graft/mcp/testing/fake-vendor";
import { createPipedreamClient } from "@graft/pipedream";
import { startFakePipedream } from "@graft/pipedream/testing/fake-pipedream";
import { createFakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath, toolboxIdOf } from "@graft/toolbox";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";
import { serve } from "@hono/node-server";
import { eq, sql } from "drizzle-orm";
import { initLogger } from "evlog";

import { createServer } from "../app";
import { createDatabaseConnections, createDatabaseCredentialRotation } from "../connections";

/**
 * The Pipedream provider proved on a laptop with nothing leaving the machine (GRA-59): the whole
 * server — Better Auth, the JSON API, the MCP endpoint, the proxy — over a throwaway Postgres, with
 * **Pipedream played by `@graft/pipedream`'s fake on a loopback port**: its token endpoint, its
 * Connect token and accounts endpoints, a Connect Link page that connects an account and sends the
 * browser back, and its proxy, which forwards the decoded vendor request to a Gmail-shaped handler
 * here. `index.ts` is not reused because two of its bindings cannot be pointed at a fake from the
 * environment on purpose — the Connect client's origin, and the proxy's upstream fetch, whose
 * resolver refuses a loopback address — so this script binds the same pieces by hand.
 *
 *   pnpm run db:start                                    # or any Postgres; the database is created
 *   pnpm --filter @graft/server pipedream-proof -- --email you@example.com --password ********
 *   pnpm --filter @graft/web dev                          # the console on :3001, proxying to :3000
 *   pnpm --filter @graft/server pipedream-proof-agent -- --token <printed> request   # the ask
 *
 * Then, in the console signed in as that person: open the ask under Pending actions, press *Connect
 * through pipedream* — the fake's link page connects a Gmail account and sends the browser back —
 * and the card settles. `pipedream-proof-agent … execute --connection <id>` runs a module that
 * reads a message and its attachment through the relay; the fake's log shows the proxy path.
 *
 * Development only. The secrets are fixed strings, the key pair is minted per boot, and the
 * database is whatever `--database-url` names, created if absent.
 */

const { values } = parseArgs({
  options: {
    "database-url": {
      type: "string",
      default: "postgresql://postgres:password@localhost:5440/graft_gra59_proof",
    },
    email: { type: "string", default: "proof@graft.test" },
    password: { type: "string", default: "proof-password-12" },
    port: { type: "string", default: "3000" },
    console: { type: "string", default: "http://localhost:3001" },
  },
});

initLogger({ env: { service: "graft-pipedream-proof", environment: "development" } });

const port = Number(values.port);
const authUrl = `http://localhost:${port}`;
const consoleUrl = values.console ?? "http://localhost:3001";
const databaseUrl = values["database-url"] ?? "";

// The database, created if absent — the integration suite's move (`database.integration.test.ts`).
const target = new URL(databaseUrl);
const databaseName = target.pathname.slice(1);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = createDb(adminUrl.toString());
const exists = await admin.execute(sql`select 1 from pg_database where datname = ${databaseName}`);
if (exists.rows.length === 0) {
  await admin.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
  console.log(`created database ${databaseName}`);
}
await admin.close();
const db = createDb(databaseUrl);
await applyMigrations(db);

// Pipedream, on a loopback port, with Gmail behind its proxy.
const ATTACHMENT = Buffer.from("Invoice INV-1042 — 12 × SKU A-100 for Acme, due 2026-10-01.\n");
const pipedream = await startFakePipedream({
  projectId: "proj_proof",
  accountName: () => "aleks@example.com",
  vendor: ({ url }) => {
    if (url.hostname !== "gmail.googleapis.com" && url.hostname !== "www.googleapis.com") {
      return Response.json({ error: "not a Google host" }, { status: 400 });
    }
    const path = url.pathname;
    if (/\/users\/me\/messages\/[^/]+\/attachments\/[^/]+$/.test(path)) {
      return Response.json({ size: ATTACHMENT.byteLength, data: ATTACHMENT.toString("base64url") });
    }
    if (/\/users\/me\/messages\/[^/]+$/.test(path)) {
      return Response.json({
        id: "18f1a2b3c4d5e6f7",
        threadId: "18f1a2b3c4d5e6f7",
        snippet: "Invoice INV-1042 attached",
        payload: {
          headers: [
            { name: "Subject", value: "Invoice INV-1042" },
            { name: "From", value: "billing@acme.example" },
          ],
          parts: [
            { partId: "0", mimeType: "text/plain", body: { size: 12 } },
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: "INV-1042.pdf",
              body: { attachmentId: "ANGjdJ8proof", size: ATTACHMENT.byteLength },
            },
          ],
        },
      });
    }
    if (path.endsWith("/users/me/messages")) {
      return Response.json({
        messages: [{ id: "18f1a2b3c4d5e6f7", threadId: "18f1a2b3c4d5e6f7" }],
        resultSizeEstimate: 1,
      });
    }
    return Response.json({ error: { code: 404, message: `no fake for ${path}` } }, { status: 404 });
  },
});
const pipedreamClient = createPipedreamClient({
  projectId: pipedream.projectId,
  environment: "development",
  clientId: pipedream.clientId,
  clientSecret: pipedream.clientSecret,
  apiOrigin: pipedream.url,
});
const providers = [createPipedreamProvider({ client: pipedreamClient }), keyringProvider];

// The seams: a fake sandbox on this disk, the local keyring, a key pair minted for this boot.
const sandbox = createFakeSandboxBackend();
const vault = createCredentialVault(createLocalKeyring("pipedream-proof-keyring-secret-32-chars!"));
const keys = await generateTestKeys();

const auth = createAuth({
  db,
  secret: "pipedream-proof-auth-secret-that-is-32-chars",
  baseURL: authUrl,
  trustedOrigins: [consoleUrl],
});

// The person and a throwaway agent, so the console has someone to sign in as and the agent script
// has a token; both idempotent across boots of the same database.
const email = values.email ?? "";
const password = values.password ?? "";
let [person] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
if (!person) {
  const signedUp = await auth.api.signUpEmail({ body: { name: "Proof", email, password } });
  person = { id: signedUp.user.id };
  console.log(`signed up ${email}`);
}
const principal = { personId: person.id };
const connectionDeps = createConnectionDeps({ encrypt: vault.encrypt }, providers);
const agent = await createAgent(
  { db },
  principal,
  { name: `proof agent ${new Date().toISOString().slice(11, 19)}` },
  defaultAgentDeps,
);

// The module the execute tool runs: a message and its attachment, raw, through the relay.
const MODULE = `export default async (input, ctx) => {
  const list = await ctx.fetch("/users/me/messages?maxResults=1");
  if (!list.ok) throw new Error(\`messages.list \${list.status}: \${await list.text()}\`);
  const { messages } = await list.json();
  const message = await (await ctx.fetch(\`/users/me/messages/\${messages[0].id}\`)).json();
  const subject = message.payload.headers.find((h) => h.name === "Subject")?.value ?? null;
  const part = message.payload.parts.find((p) => p.body?.attachmentId);
  const attachment = await (
    await ctx.fetch(\`/users/me/messages/\${message.id}/attachments/\${part.body.attachmentId}\`)
  ).json();
  const bytes = Buffer.from(attachment.data, "base64url");
  return { subject, filename: part.filename, size: bytes.byteLength, text: bytes.toString("utf8") };
};
`;
const toolDir = join(sandbox.toolboxRoot(toolboxIdOf(person.id)), "tools/gmail/read-attachment/v1");
await mkdir(toolDir, { recursive: true });
await writeFile(join(toolDir, "index.ts"), MODULE);

const handoff = {
  consoleUrl,
  secret: "pipedream-proof-handoff-secret-that-is-32",
  waitMs: 2_000,
  ttlMs: 24 * 60 * 60 * 1000,
};
const mcp = createMcpDeps({
  db,
  connection: connectionDeps,
  sandbox,
  keys,
  proxyPublicUrl: `${authUrl}/api/proxy`,
  handoff,
  oauthRedirectUri: oauthRedirectUri(authUrl),
  resourceMetadataUrl: protectedResourceMetadataUrl(authUrl),
  model: null,
});
const mcpOAuth = { db, deps: defaultMcpOAuthDeps, agent: defaultAgentDeps, authUrl, consoleUrl };

const app = createServer({
  keys,
  vault,
  connections: createDatabaseConnections(db, providers),
  credentialRotation: createDatabaseCredentialRotation(db, connectionDeps),
  followRedirects: false,
  // A plain fetch: the default's resolver refuses the loopback the fake Pipedream listens on, which
  // is the rule under test in `@graft/proxy` and not here.
  upstreamFetch: async (request, { signal }) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
      redirect: "manual",
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
    };
  },
  api: {
    auth: {
      handler: (request) => auth.handler(request),
      getSession: (headers) => auth.api.getSession({ headers }),
    },
    deps: {
      db,
      agent: defaultAgentDeps,
      connection: connectionDeps,
      workingSet: defaultWorkingSetDeps,
      tool: defaultToolDeps,
      ledger: defaultLedgerDeps,
      approval: defaultApprovalDeps,
      pendingAction: defaultPendingActionDeps,
      modelKey: createModelKeyDeps({ encrypt: vault.encrypt }),
    },
    corsOrigins: [consoleUrl],
    handoff,
    oauth: { authUrl, decrypt: vault.decrypt },
    mcpOAuth,
    authUrl,
  },
  mcpOAuth,
  mcp,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    [
      `pipedream proof listening on http://localhost:${info.port} — providers ${providers.map((p) => p.name).join(", ")}`,
      `fake Pipedream at ${pipedream.url} (project ${pipedream.projectId}); the console at ${consoleUrl}`,
      `sign in as ${email} with the password you passed; the throwaway agent is ${agent.agent.name}`,
      `agent token (shown once): ${agent.token}`,
      `next: pnpm --filter @graft/server pipedream-proof-agent -- --token ${agent.token} request`,
      `the module the execute tool runs: ${sandboxPath("tools/gmail/read-attachment/v1")}`,
    ].join("\n"),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    mcp.notifier?.close();
    mcp.inFlight?.close();
    Promise.allSettled([pipedream.close(), sandbox.close(), db.close()]).finally(() =>
      process.exit(0),
    );
  });
}
