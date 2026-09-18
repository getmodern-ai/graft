import { randomBytes } from "node:crypto";

import { createAuth } from "@graft/auth";
import {
  createAgent,
  createConnectionDeps,
  createModelKeyDeps,
  createTool,
  defaultAgentDeps,
  defaultApprovalDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  deletePersonModelKey,
  findPersonModelKeyRow,
  getConnection,
  getPersonModelKey,
  getToolById,
  listConnections,
  listWorkingSet,
  modelKeyScope,
  promoteTool,
  registerConnection,
  requireAgent,
  revokeAgent,
  revokeConnection,
  type ServiceContext,
  setApproval,
  setConnectionCredential,
  setPersonModelKey,
} from "@graft/core";
import { createDb, type Database } from "@graft/db";
import { applyMigrations } from "@graft/db/migrate";
import { addConnectionHosts } from "@graft/db/repo/connection";
import { markPersonEmailVerified } from "@graft/db/repo/person";
import type { ProxyEvent, UpstreamRequest } from "@graft/proxy";
import {
  CAPABILITY_TOKEN_ALG,
  type CapabilityTokenKeys,
  importCapabilityTokenKeys,
  mintCapabilityToken,
} from "@graft/token";
import {
  CredentialScopeMismatchError,
  createCredentialVault,
  createLocalKeyring,
} from "@graft/vault";
import { sql } from "drizzle-orm";
import { initLogger } from "evlog";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { createDatabaseConnections } from "./connections";

/**
 * The one suite in the repository that needs Postgres, and the one thing the fakes cannot show: that
 * the migration chain applies to an empty database, that Better Auth signs a person up and in over
 * it, that an agent's token resolves through the real `agent` table, that the vault's ciphertext
 * survives a `bytea` column and comes back through the proxy's own read, and that the scope
 * predicates `packages/db`'s rendered-SQL suite pins do what they say against real rows.
 *
 * `TEST_DATABASE_URL` names a Postgres this suite may create databases on; each run makes a
 * throwaway database, migrates it, and drops it afterwards, so "an empty Postgres" is literal and
 * nothing leaks between runs or into a developer's database. Locally:
 *
 *   pnpm run db:start
 *   TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/graft pnpm --filter @graft/server test
 *
 * Unset, the suite skips itself; under `CI` it fails instead, so the `postgres` service in
 * `.github/workflows/ci.yml` cannot be dropped in an unrelated change while every run stays green.
 */
const adminUrl = process.env.TEST_DATABASE_URL;

if (!adminUrl && process.env.CI) {
  throw new Error(
    "TEST_DATABASE_URL is unset under CI. The database integration suite is the one suite that needs " +
      "a real Postgres; restore the `postgres` service in .github/workflows/ci.yml rather than letting this skip.",
  );
}

initLogger({ silent: true });

const SECRET = "test-secret-that-is-long-enough-32";
const AUTH_SECRET = "auth-secret-that-is-long-enough-32-chars";
const API_KEY = "sk_live_the_real_vendor_key_0123456789";
const MODEL_API_KEY = "sk-ant-a-persons-own-model-key-0123456789";

describe.skipIf(!adminUrl)("the schema, the account and the services over a real Postgres", () => {
  let admin: Database;
  let db: Database;
  let databaseName: string;
  let keys: CapabilityTokenKeys;
  const vault = createCredentialVault(createLocalKeyring(SECRET));
  const connectionDeps = createConnectionDeps({ encrypt: vault.encrypt });

  /**
   * Sign a fresh person up through Better Auth and answer their id. Registering opens no session
   * until the address is verified (GRA-94), so the suite verifies the row the way the boot verifies
   * its admin and then signs in for the cookie.
   */
  async function signUp(email: string): Promise<string> {
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: "http://localhost:3000" });
    const password = "a-password-that-is-long-enough";
    await auth.api.signUpEmail({ body: { email, password, name: email.split("@")[0] ?? "" } });
    await markPersonEmailVerified(db, email);
    const { headers } = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = headers.get("set-cookie") ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) throw new Error("sign-in opened no session");
    return session.user.id;
  }

  beforeAll(async () => {
    if (!adminUrl) return;
    admin = createDb(adminUrl);
    databaseName = `graft_it_${randomBytes(6).toString("hex")}`;
    await admin.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    db = createDb(url.toString());
    await applyMigrations(db);

    const pair = await generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true });
    keys = await importCapabilityTokenKeys({
      privateKeyPem: await exportPKCS8(pair.privateKey),
      publicKeyPem: await exportSPKI(pair.publicKey),
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    if (admin && databaseName) {
      await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${databaseName}"`));
      await admin.close();
    }
  });

  it("applies the migration chain to an empty database, creating every table", async () => {
    const rows = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const names = rows.rows.map((row) => row.tablename);
    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "agent",
      "agent_connection",
      "connection",
      "authored_tool",
      "tool_version",
      "working_set",
      "working_set_change",
      "approval",
      "build_approval",
      "pending_action",
      "acquire_job",
      "usage_ledger",
    ]) {
      expect(names).toContain(table);
    }
  });

  /** ADR 0007: the tier column on every owned table, `person` its only value in use. */
  it("gives every owned table an owner column defaulting to person", async () => {
    const rows = await db.execute<{ table_name: string; column_default: string | null }>(
      sql`select table_name, column_default from information_schema.columns
          where table_schema = 'public' and column_name = 'owner' order by table_name`,
    );
    expect(rows.rows.map((row) => row.table_name)).toEqual([
      "acquire_attempt",
      "acquire_job",
      "acquire_trace",
      "agent",
      "agent_connection",
      "approval",
      "authored_tool",
      "build_approval",
      "connection",
      "mcp_authorization_code",
      "mcp_client",
      "mcp_token",
      "pending_action",
      "person_model_key",
      "tool_version",
      "usage_ledger",
      "working_set",
      "working_set_change",
    ]);
    for (const row of rows.rows) expect(row.column_default).toBe("'person'::text");
  });

  it("signs a person up and in through Better Auth, and the session resolves to them once the address is verified", async () => {
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: "http://localhost:3000" });
    const email = "ada@example.com";
    const signedUp = await auth.api.signUpEmail({
      body: { email, password: "a-password-that-is-long-enough", name: "Ada" },
      returnHeaders: true,
    });
    expect(signedUp.response.user.email).toBe(email);
    // Registering opened no session (GRA-94): no cookie, and a sign-in is refused until the click.
    expect(signedUp.headers.get("set-cookie") ?? "").not.toContain("better-auth.session_token");
    await expect(
      auth.api.signInEmail({ body: { email, password: "a-password-that-is-long-enough" } }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_NOT_VERIFIED" } });
    expect(await markPersonEmailVerified(db, email)).toBe(true);

    const signedIn = await auth.api.signInEmail({
      body: { email, password: "a-password-that-is-long-enough" },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("better-auth.session_token");

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(signedUp.response.user.id);
    expect(session?.user.email).toBe(email);

    await expect(
      auth.api.signInEmail({ body: { email, password: "wrong-password-entirely" } }),
    ).rejects.toThrow();
  });

  it("returns an agent's token once, stores a hash, and resolves the token to that agent and no other", async () => {
    const personId = await signUp("grace@example.com");
    const ctx: ServiceContext = { db };
    const principal = { personId };

    const first = await createAgent(ctx, principal, { name: "laptop Hermes" }, defaultAgentDeps);
    const second = await createAgent(ctx, principal, { name: "ops OpenClaw" }, defaultAgentDeps);
    expect(first.token).not.toBe(second.token);

    const stored = await db.execute<{ token_hash: string; token_prefix: string }>(
      sql`select token_hash, token_prefix from agent where id = ${first.agent.id}`,
    );
    expect(stored.rows[0]?.token_hash).not.toContain(first.token.slice(5));
    expect(stored.rows[0]?.token_hash).toHaveLength(64);
    expect(stored.rows[0]?.token_prefix).toBe(first.token.slice(0, 8));

    await expect(requireAgent(ctx, first.token, defaultAgentDeps)).resolves.toEqual({
      personId,
      agentId: first.agent.id,
    });
    await expect(requireAgent(ctx, second.token, defaultAgentDeps)).resolves.toMatchObject({
      agentId: second.agent.id,
    });

    await revokeAgent(ctx, principal, second.agent.id, defaultAgentDeps);
    await expect(requireAgent(ctx, second.token, defaultAgentDeps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(requireAgent(ctx, "grft_not_a_token", defaultAgentDeps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("round-trips a credential: ciphertext in the row, decrypted by the proxy alone, never in the public shape", async () => {
    const personId = await signUp("linus@example.com");
    const ctx: ServiceContext = { db };
    const principal = { personId };

    const registered = await registerConnection(
      ctx,
      principal,
      {
        vendor: "demo",
        displayName: "Demo vendor",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-demo-key" },
        primaryHost: "https://api.demo.example/v2",
        hosts: ["files.demo.example"],
      },
      connectionDeps,
    );
    expect(registered.credentialSetAt).toBeNull();
    // Migration 0006's default, read back through the row (ADR 0019).
    expect(registered.provider).toBe("keyring");

    const withCredential = await setConnectionCredential(
      ctx,
      principal,
      registered.id,
      { apiKey: API_KEY },
      connectionDeps,
    );
    expect(withCredential.credentialSetAt).toBeInstanceOf(Date);
    expect(JSON.stringify(withCredential)).not.toContain(API_KEY);
    expect(withCredential).not.toHaveProperty("credentialCiphertext");

    const listed = await listConnections(ctx, principal, connectionDeps);
    expect(JSON.stringify(listed)).not.toContain(API_KEY);

    // The proxy's read: the row's ciphertext, decryptable under this row's scope and no other.
    const proxyRow = await createDatabaseConnections(db).get(registered.id);
    expect(Buffer.isBuffer(proxyRow?.credentialCiphertext)).toBe(true);
    if (!proxyRow?.credentialCiphertext) throw new Error("no ciphertext");
    expect(Buffer.from(proxyRow.credentialCiphertext).includes(Buffer.from(API_KEY))).toBe(false);
    await expect(
      vault.decrypt(proxyRow.credentialCiphertext, { personId, connectionId: registered.id }),
    ).resolves.toEqual({ apiKey: API_KEY });
    await expect(
      vault.decrypt(proxyRow.credentialCiphertext, { personId, connectionId: "another" }),
    ).rejects.toThrow(CredentialScopeMismatchError);

    // And end to end: the server over the database, a minted token, the key injected at the vendor.
    const forwarded: UpstreamRequest[] = [];
    const app = createServer({
      keys,
      vault,
      connections: createDatabaseConnections(db),
      followRedirects: false,
      upstreamFetch: async (request) => {
        forwarded.push(request);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      log: () => {},
    });
    const agent = await createAgent(
      ctx,
      principal,
      { name: "smoke", connectionIds: [registered.id] },
      defaultAgentDeps,
    );
    const token = await mintCapabilityToken(
      {
        personId,
        agentId: agent.agent.id,
        connectionIds: [registered.id],
        tool: "execute",
        ttlSeconds: 60,
      },
      keys,
    );
    const res = await app.request(`/api/proxy/c/${registered.id}/items`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(forwarded[0]?.url).toBe("https://api.demo.example/v2/items");
    expect(forwarded[0]?.headers.get("x-demo-key")).toBe(API_KEY);

    // Another person's token is refused for this row, by the proxy, from the row's own owner column.
    const other = await signUp("other@example.com");
    const foreign = await mintCapabilityToken(
      {
        personId: other,
        agentId: "agent_x",
        connectionIds: [registered.id],
        tool: "execute",
        ttlSeconds: 60,
      },
      keys,
    );
    const refused = await app.request(`/api/proxy/c/${registered.id}/items`, {
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "person_mismatch" });
  });

  it("keeps one agent's working set from another's, and one person's connections from another's", async () => {
    const alice = await signUp("alice@example.com");
    const bob = await signUp("bob@example.com");
    const ctx: ServiceContext = { db };

    const a1 = await createAgent(ctx, { personId: alice }, { name: "a1" }, defaultAgentDeps);
    const a2 = await createAgent(ctx, { personId: alice }, { name: "a2" }, defaultAgentDeps);
    const tool = await createTool(
      ctx,
      { personId: alice },
      {
        vendor: "demo",
        name: "list-items",
        description: "Lists items",
        inputSchema: { type: "object" },
        annotations: { readOnly: true, destructive: false },
      },
      defaultToolDeps,
    );
    const promoted = await promoteTool(
      ctx,
      { personId: alice, agentId: a1.agent.id },
      tool.id,
      "agent",
      defaultWorkingSetDeps,
    );
    expect(promoted.changed).toBe(true);

    const own = await listWorkingSet(
      ctx,
      { personId: alice, agentId: a1.agent.id },
      defaultWorkingSetDeps,
    );
    expect(own.map((entry) => entry.tool.name)).toEqual(["list-items"]);
    // The other agent of the same person: nothing.
    expect(
      await listWorkingSet(ctx, { personId: alice, agentId: a2.agent.id }, defaultWorkingSetDeps),
    ).toEqual([]);
    // The right agent under the wrong person: nothing — both ids are in the predicate.
    expect(
      await listWorkingSet(ctx, { personId: bob, agentId: a1.agent.id }, defaultWorkingSetDeps),
    ).toEqual([]);

    await registerConnection(
      ctx,
      { personId: alice },
      {
        vendor: "demo",
        displayName: "Alice's",
        scheme: "bearer",
        primaryHost: "https://api.demo.example",
      },
      connectionDeps,
    );
    const aliceRows = await listConnections(ctx, { personId: alice }, connectionDeps);
    expect(aliceRows.map((row) => row.displayName)).toEqual(["Alice's"]);
    expect(await listConnections(ctx, { personId: bob }, connectionDeps)).toEqual([]);
    expect(
      await getConnection(ctx, { personId: bob }, aliceRows[0]?.id ?? "", connectionDeps),
    ).toBeNull();
  });

  /** ADR 0007: a revoke clears the credential and the approvals for every agent, and leaves the tool. */
  /**
   * The one statement behind a gateway row's widening (GRA-58): an array union computed in SQL, so
   * two widenings at once both land — the read-modify-write Greptile found on #45 would have kept
   * one. Against real Postgres because `unnest`, `ANY` and the `text[]` parameter are exactly what
   * a fake cannot show.
   */
  it("appends hosts to a connection in one statement: concurrent widenings both land, nothing is doubled, the order is kept", async () => {
    const personId = await signUp("widener@example.com");
    const ctx: ServiceContext = { db };
    const principal = { personId };
    const connection = await registerConnection(
      ctx,
      principal,
      {
        vendor: "acme",
        displayName: "Acme",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-key" },
        primaryHost: "https://api.acme.example",
        hosts: ["files.acme.example"],
      },
      connectionDeps,
    );
    expect(connection.hosts).toEqual(["api.acme.example", "files.acme.example"]);

    const [first, second] = await Promise.all([
      addConnectionHosts(db, personId, connection.id, ["files.acme.example", "cdn.acme.example"]),
      addConnectionHosts(db, personId, connection.id, ["uploads.acme.example", "api.acme.example"]),
    ]);
    const final = await getConnection(ctx, principal, connection.id, connectionDeps);
    expect(final?.hosts.slice(0, 2)).toEqual(["api.acme.example", "files.acme.example"]);
    expect([...(final?.hosts ?? [])].sort()).toEqual([
      "api.acme.example",
      "cdn.acme.example",
      "files.acme.example",
      "uploads.acme.example",
    ]);
    expect(new Set(final?.hosts).size).toBe(final?.hosts.length);
    // Each statement answered the row as it stood after its own write; the later one saw both.
    expect([first, second].some((row) => row?.hosts.length === 4)).toBe(true);

    // Another person's id reaches no row.
    expect(
      await addConnectionHosts(db, "someone-else", connection.id, ["x.acme.example"]),
    ).toBeNull();
  });

  it("revokes a connection: ciphertext and approvals gone, the authored tool still there", async () => {
    const personId = await signUp("revoker@example.com");
    const ctx: ServiceContext = { db };
    const principal = { personId };

    const connection = await registerConnection(
      ctx,
      principal,
      {
        vendor: "acme",
        displayName: "Acme",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-key" },
        primaryHost: "https://api.acme.example",
      },
      connectionDeps,
    );
    await setConnectionCredential(ctx, principal, connection.id, { apiKey: "k" }, connectionDeps);
    const agent = await createAgent(ctx, principal, { name: "a" }, defaultAgentDeps);
    const scope = { personId, agentId: agent.agent.id };
    const tool = await createTool(
      ctx,
      principal,
      {
        vendor: "acme",
        name: "create-order",
        description: "Creates an order",
        inputSchema: { type: "object" },
        annotations: { readOnly: false, destructive: false },
        defaultConnectionId: connection.id,
      },
      defaultToolDeps,
    );
    await setApproval(ctx, scope, tool.id, "allow", defaultApprovalDeps);

    const result = await revokeConnection(ctx, principal, connection.id, connectionDeps);
    expect(result).toMatchObject({ approvalsDeleted: 1, buildApprovalsDeleted: 0 });
    expect(result?.connection.revokedAt).toBeInstanceOf(Date);
    expect(result?.connection.credentialSetAt).toBeNull();

    const proxyRow = await createDatabaseConnections(db).get(connection.id);
    expect(proxyRow?.credentialCiphertext).toBeNull();
    // The database binding carries the stamp (GRA-68), so a capability token minted from a scope
    // that still names the row is refused as revoked, not as a row missing a scheme or a credential.
    expect(proxyRow?.revokedAt).toBeInstanceOf(Date);
    const events: ProxyEvent[] = [];
    const app = createServer({
      keys,
      vault,
      connections: createDatabaseConnections(db),
      followRedirects: false,
      upstreamFetch: async () => {
        throw new Error("a revoked connection reaches no vendor");
      },
      log: (event) => events.push(event),
    });
    const token = await mintCapabilityToken(
      {
        personId,
        agentId: agent.agent.id,
        connectionIds: [connection.id],
        tool: "execute",
        ttlSeconds: 60,
      },
      keys,
    );
    const refused = await app.request(`/api/proxy/c/${connection.id}/items`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      reason: "connection_revoked",
      message: "The person revoked this connection; ask them to reconnect it in the console",
    });
    expect(events.at(-1)).toMatchObject({
      outcome: "connection_revoked",
      connectionId: connection.id,
    });
    expect(await getToolById(ctx, principal, tool.id, defaultToolDeps)).toMatchObject({
      name: "create-order",
    });

    const approvals = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from approval where tool_id = ${tool.id}`,
    );
    expect(approvals.rows[0]?.n).toBe("0");
  });

  it("round-trips a person's model key: ciphertext in the row, opened under that person's model-key scope alone, never in the public shape", async () => {
    const personId = await signUp("model-key-owner@example.com");
    const other = await signUp("model-key-other@example.com");
    const ctx: ServiceContext = { db };
    const deps = createModelKeyDeps({ encrypt: vault.encrypt });

    const entered = await setPersonModelKey(
      ctx,
      { personId },
      { provider: "openai", apiKey: MODEL_API_KEY, authoringModel: "gpt-test" },
      deps,
    );
    expect(entered).toMatchObject({ provider: "openai", authoringModel: "gpt-test" });
    expect(JSON.stringify(entered)).not.toContain(MODEL_API_KEY);
    expect(entered).not.toHaveProperty("keyCiphertext");

    // The resolver's read: the ciphertext, decryptable under this person's model-key scope and no other.
    const row = await findPersonModelKeyRow(ctx, personId, deps);
    if (!row) throw new Error("no row");
    expect(Buffer.isBuffer(row.keyCiphertext)).toBe(true);
    expect(Buffer.from(row.keyCiphertext).includes(Buffer.from(MODEL_API_KEY))).toBe(false);
    await expect(vault.decrypt(row.keyCiphertext, modelKeyScope(personId))).resolves.toEqual({
      apiKey: MODEL_API_KEY,
    });
    await expect(vault.decrypt(row.keyCiphertext, modelKeyScope(other))).rejects.toThrow(
      CredentialScopeMismatchError,
    );
    // Nor under a connection's scope for the same person: the slot is part of the binding.
    await expect(
      vault.decrypt(row.keyCiphertext, { personId, connectionId: "conn_x" }),
    ).rejects.toThrow(CredentialScopeMismatchError);
    expect(await findPersonModelKeyRow(ctx, other, deps)).toBeNull();

    // One row per person: a second entry replaces the first; a delete leaves none.
    await setPersonModelKey(ctx, { personId }, { provider: "anthropic", apiKey: "second" }, deps);
    expect(await getPersonModelKey(ctx, { personId }, deps)).toMatchObject({
      provider: "anthropic",
      authoringModel: null,
    });
    expect(await deletePersonModelKey(ctx, { personId }, deps)).toBe(true);
    expect(await getPersonModelKey(ctx, { personId }, deps)).toBeNull();
  });
});
