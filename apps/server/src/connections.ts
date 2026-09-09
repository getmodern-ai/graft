import { toProxyConnection } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { findConnectionByIdUnscoped } from "@graft/db/repo/connection";
import {
  AUTH_SCHEMES,
  type ProxyConnection,
  type ProxyDeps,
  SCHEME_CREDENTIAL_FIELDS,
  SCHEME_OPTIONAL_CREDENTIAL_FIELDS,
} from "@graft/proxy";
import type { EncryptOnlyVault } from "@graft/vault";
import { z } from "zod";

/**
 * The connection sources the proxy reads through `ProxyDeps["connections"]`: the database, and an
 * in-memory store a laptop seeds from a file before there is a console to enter a connection in
 * (ADR 0006). `index.ts` layers the seed over the database when `GRAFT_DEV_SEED` is set; the proxy
 * sees one `get` either way.
 */

/**
 * The database as the proxy's connection source. The read is the *unscoped* one on purpose: a
 * vendor call carries no session, and the capability token's `person` claim is what the proxy
 * compares the row's owner against — that comparison is the whole authorisation (ADR 0010), and it
 * happens in the proxy package. `toProxyConnection` builds the shape field by field, so a column
 * added to the table later does not ride into the proxy by accident.
 */
export function createDatabaseConnections(db: DbOrTx): ProxyDeps["connections"] {
  return {
    get: async (connectionId) => {
      const row = await findConnectionByIdUnscoped(db, connectionId);
      return row ? toProxyConnection(row) : null;
    },
  };
}

export type ConnectionStore = ProxyDeps["connections"] & {
  put(connection: ProxyConnection): void;
  ids(): string[];
};

export function createInMemoryConnections(): ConnectionStore {
  const rows = new Map<string, ProxyConnection>();
  return {
    get: async (connectionId) => rows.get(connectionId) ?? null,
    put: (connection) => {
      rows.set(connection.id, connection);
    },
    ids: () => [...rows.keys()],
  };
}

/** The seed's rows first, the database for everything else — a seeded id shadows a database row. */
export function layerConnections(
  first: ProxyDeps["connections"],
  second: ProxyDeps["connections"],
): ProxyDeps["connections"] {
  return {
    get: async (connectionId) => (await first.get(connectionId)) ?? second.get(connectionId),
  };
}

/**
 * One seeded connection: the row's public shape plus the credential in the clear, which the seed
 * loader encrypts through the vault and then forgets. Development only (`GRAFT_DEV_SEED` in
 * `@graft/env`, refused in production): a credential on disk is what the vault exists to prevent,
 * and this is the one place it is tolerated, on a laptop, to reach a real vendor through the proxy.
 */
export const connectionSeed = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "a connection id is up to 128 URL-safe characters"),
  personId: z.string().min(1),
  authScheme: z.enum(AUTH_SCHEMES),
  /** The base URL the plain path form resolves against — `https://api.vendor.example/v1`. */
  primaryHost: z.url(),
  /** Hostnames the connection may reach besides the primary's, which is added for you. */
  hosts: z.array(z.string().min(1)).default([]),
  schemeConfig: z.record(z.string(), z.string()).default({}),
  /** The scheme's credential fields — `SCHEME_CREDENTIAL_FIELDS` names them — in the clear. */
  credential: z.record(z.string(), z.string()),
});

export const connectionSeeds = z.array(connectionSeed);

export type ConnectionSeed = z.infer<typeof connectionSeed>;

/**
 * Encrypt each seed's credential under the connection's scope and put the row in the store. The
 * credential's field names are checked against the scheme's table first, so a typo in the seed is a
 * sentence at boot rather than a `credential_incomplete` at the first vendor call.
 */
export async function seedConnections(
  store: ConnectionStore,
  vault: EncryptOnlyVault,
  seeds: readonly ConnectionSeed[],
): Promise<void> {
  for (const seed of seeds) {
    const required = SCHEME_CREDENTIAL_FIELDS[seed.authScheme];
    const optional = SCHEME_OPTIONAL_CREDENTIAL_FIELDS[seed.authScheme] ?? [];
    const given = Object.keys(seed.credential);
    const missing = required.filter((field) => !given.includes(field));
    const unknown = given.filter((field) => !required.includes(field) && !optional.includes(field));
    if (missing.length > 0 || unknown.length > 0) {
      throw new Error(
        `connection ${seed.id} (${seed.authScheme}) credential fields: ` +
          `missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]; ` +
          `expected [${required.join(", ")}]${optional.length ? ` and optionally [${optional.join(", ")}]` : ""}`,
      );
    }
    const primary = new URL(seed.primaryHost);
    store.put({
      id: seed.id,
      personId: seed.personId,
      authScheme: seed.authScheme,
      primaryHost: seed.primaryHost,
      hosts: [...new Set([primary.hostname, ...seed.hosts.map((host) => host.toLowerCase())])],
      schemeConfig: seed.schemeConfig,
      credentialCiphertext: await vault.encrypt(seed.credential, {
        personId: seed.personId,
        connectionId: seed.id,
      }),
    });
  }
}
