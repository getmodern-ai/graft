import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { bytea, owned } from "./columns";

/**
 * How the proxy presents the credential to the vendor — the scheme plugins of `@graft/proxy`
 * (ADR 0010). Stored as the plugin's name, never as signing code: the agent proposes a scheme and
 * its parameters, and the proxy owns what each scheme *does*. This list and the proxy's
 * `AUTH_SCHEMES` are asserted equal in `packages/core`, which depends on both; a scheme added to
 * one without the other fails a test rather than a vendor call.
 */
export const connectionScheme = [
  "api_key_header",
  "api_key_query",
  "bearer",
  "basic",
  "oauth2_client_credentials",
  "unleashed_hmac",
  "snowflake_keypair_jwt",
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
     * Authorization-code OAuth, with a client the person registered (ADR 0005). The client id,
     * the endpoints and the scopes are configuration; the client secret is a credential of its
     * own, encrypted like the other; the refresh state is what single-flight refresh reads and
     * writes. All null for a key-shaped scheme. The flow itself is GRA-30's.
     */
    oauthClientId: text("oauth_client_id"),
    oauthClientSecretCiphertext: bytea("oauth_client_secret_ciphertext"),
    oauthAuthorizeUrl: text("oauth_authorize_url"),
    oauthTokenUrl: text("oauth_token_url"),
    oauthScopes: text("oauth_scopes").array(),
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
  ],
);

export const connectionRelations = relations(connection, ({ one }) => ({
  person: one(user, { fields: [connection.personId], references: [user.id] }),
}));

export type Connection = typeof connection.$inferSelect;
export type NewConnection = typeof connection.$inferInsert;
