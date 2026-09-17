import { relations, sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { bytea, owned } from "./columns";

/**
 * How the proxy presents the request to the vendor — the scheme plugins of `@graft/proxy`
 * (ADR 0010). Stored as the plugin's name, never as signing code: the agent proposes a scheme and
 * its parameters, and the proxy owns what each scheme *does*. A relay scheme (ADR 0019) belongs
 * here too: a connection whose provider relays records the relay it goes through as its scheme, so
 * the column says how the request leaves for every row — `pipedream_connect_proxy` is the first
 * (GRA-59). This list and the proxy's `[...AUTH_SCHEMES, ...RELAY_SCHEMES]` are asserted equal in
 * `packages/core`, which depends on both; a scheme added to one without the other fails a test
 * rather than a vendor call. The column is `text` with the enum on the type alone, so adding a name
 * here changes no SQL and needs no migration.
 */
export const connectionScheme = [
  "api_key_header",
  "api_key_query",
  "bearer",
  "basic",
  "oauth2_client_credentials",
  "oauth_authorization_code",
  "unleashed_hmac",
  "snowflake_keypair_jwt",
  "pipedream_connect_proxy",
] as const;
export type ConnectionScheme = (typeof connectionScheme)[number];

/**
 * A **connection**: one vendor account a person has given Graft — its scheme, its credential and
 * the set of hosts it may reach (CONTEXT.md). Owned by the person, never by an agent (ADR 0007):
 * Gmail is entered once however many harnesses the person runs, and revoking it affects every
 * agent at once.
 *
 * Credentials are write-only after entry. The ciphertext columns are read by the proxy's binding
 * in `apps/server` and by nothing else; the row's public shape carries `credentialSetAt` and no
 * credential material (GRA-1, "Tenancy and the schema").
 */
export const connection = pgTable(
  "connection",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Where the connection comes from (ADR 0019): the **provider** that decides how the person
     * connects the vendor and what happens to a vendor request at call time. `keyring` — the
     * default, and every row until another provider is enabled — is a credential the person
     * entered in the console, held in `credential_ciphertext` and injected by the proxy. A relay
     * provider's row carries its name here and holds no credential of its own: the proxy relays
     * the call to the upstream that does. Which providers are enabled is the deployment's
     * (`apps/server/src/backings.ts`); the column carries the name so a row outlives the process
     * that made it.
     */
    provider: text("provider").notNull().default("keyring"),
    /**
     * The provider's own identifier for what this row is connected to — an account id at a broker,
     * a route name at a gateway — opaque to everything but the provider, and never a secret. Null
     * for a keyring connection, which is identified by its own ciphertext. One text column rather
     * than one per provider (ADR 0019): every relay provider named so far holds one identifier per
     * connection, and a provider that comes to need more adds a column named for itself then.
     * Kept through a revoke until the provider has released what it holds (`repo/connection.ts`,
     * `recordProviderRelease`), because the release is *by* this identifier and a failed one is
     * retried from it; cleared the moment the release succeeds.
     */
    providerRef: text("provider_ref"),
    /**
     * When the provider last failed to release what it held for this row on a revoke (ADR 0019;
     * GRA-59) — a broker that could not be reached to delete the account. Set on the failure, so the
     * fact outlives the request that met it, and cleared by the retry that succeeds
     * (`recordProviderRelease`). Null for a row whose provider holds nothing or has let go.
     */
    providerReleaseFailedAt: timestamp("provider_release_failed_at"),
    /**
     * The vendor slug — `gmail`, `unleashed`, `cartoncloud` — the key an authored tool binds to
     * (ADR 0007: a tool is bound to a vendor, not a connection row, so it survives a revoke and
     * re-asks after reconnection). Lowercase letters, digits and hyphens; the service refuses
     * anything else.
     */
    vendor: text("vendor").notNull(),
    /** What the console and the handoff page show: "Acme Unleashed (production)". */
    displayName: text("display_name").notNull(),
    scheme: text("scheme", { enum: connectionScheme }).notNull(),
    /**
     * The scheme's non-secret parameters — a header name, a prefix, a query parameter name, a
     * token URL. Never a secret: those go in the ciphertext, and this column is readable by anyone
     * with the row.
     */
    schemeConfig: jsonb("scheme_config").$type<Record<string, string>>().notNull().default({}),
    /**
     * The base URL the plain proxy form resolves against — `https://api.vendor.example/v1`.
     * Public and https, checked at registration by the service and again by the proxy at
     * resolution, because a hostname can be pointed at a private address after the fact.
     */
    primaryHost: text("primary_host").notNull(),
    /**
     * Every hostname the connection may reach, the primary's among them — the set the person saw
     * on the handoff page (ADR 0010). The proxy's explicit host form is refused outside it, and a
     * redirect is followed only within it. Lower-case.
     */
    hosts: text("hosts").array().notNull(),
    /**
     * The credential fields, envelope-encrypted by `@graft/vault` with this row's person and
     * connection id in the encryption context — so a ciphertext copied onto another row fails to
     * decrypt rather than handing that row a credential. Null until the person enters one.
     */
    credentialCiphertext: bytea("credential_ciphertext"),
    /**
     * When the credential was last entered — the one thing the public shape says about a
     * credential: whether one is set, and since when, which is what a re-entry form needs.
     */
    credentialSetAt: timestamp("credential_set_at"),
    /**
     * Authorization-code OAuth, with a client the person registered (ADR 0005). GRA-30 kept the
     * client id, the two endpoints and the scopes in `scheme_config` beside every other scheme's
     * parameters, and the client secret in `credential_ciphertext` beside the tokens the consent
     * yields — one record, so the proxy decrypts once and the form renders from one table — which
     * leaves these five columns from GRA-6 unwritten. They stay until a migration drops them; nothing
     * reads them (`packages/core`'s `toConnectionOutput` does not).
     */
    oauthClientId: text("oauth_client_id"),
    oauthClientSecretCiphertext: bytea("oauth_client_secret_ciphertext"),
    oauthAuthorizeUrl: text("oauth_authorize_url"),
    oauthTokenUrl: text("oauth_token_url"),
    oauthScopes: text("oauth_scopes").array(),
    /**
     * The non-secret state of an authorization-code connection, read by the console and written
     * by the consent and the refresh (ADR 0005): when the person consented, when the access token
     * dies, when it was last refreshed, whether a refresh was refused and the person has to consent
     * again — and, between the person clicking Connect and the vendor calling back, the PKCE
     * verifier the callback exchanges the code with. `packages/core`'s `OAuthState` is the shape;
     * this column stores it unread. Never a token: those are in the ciphertext.
     */
    oauthRefreshState: jsonb("oauth_refresh_state").$type<Record<string, unknown>>(),
    /**
     * Set when the person revokes the connection. The row stays for its history and so the
     * vendor slug it carries keeps naming the authored tools bound to it; both ciphertexts are
     * cleared in the same write, and every approval for the vendor goes with them (ADR 0007).
     */
    revokedAt: timestamp("revoked_at"),
    ...owned(),
  },
  (table) => [
    index("connection_person_id_idx").on(table.personId),
    // "The person's connections for this vendor" — what a revoke and a tool binding both ask.
    index("connection_person_id_vendor_idx").on(table.personId, table.vendor),
    /**
     * One row per account at a provider (ADR 0019; GRA-59): a link's return that lands twice at
     * once would otherwise claim the same account for two rows, since the account is discovered
     * before the write. The database refuses the second, and the return re-reads the ask the first
     * answered. Partial, because the keyring's rows have no reference and are as many as they are.
     */
    uniqueIndex("connection_provider_ref_idx")
      .on(table.provider, table.providerRef)
      .where(sql`${table.providerRef} is not null`),
  ],
);

export const connectionRelations = relations(connection, ({ one }) => ({
  person: one(user, { fields: [connection.personId], references: [user.id] }),
}));

export type Connection = typeof connection.$inferSelect;
export type NewConnection = typeof connection.$inferInsert;
