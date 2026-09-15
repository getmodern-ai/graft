---
status: accepted
---

# MCP clients authenticate with OAuth, and the consent mints the agent

A chat product — Claude, ChatGPT, the MCP Inspector, any client that speaks the MCP authorization
specification — connects to Graft by pasting `https://app.getgraft.ai/mcp` and nothing else. The
endpoint's `401` names the protected resource metadata (RFC 9728), that names Graft's own
authorization server (RFC 8414) at the same origin, the product registers itself (RFC 7591) and
sends the person to Graft. The person signs in to the console and lands on a **consent page** that
says which client is asking, by the name it registered, and where it will be sent back; on it they
**mint the agent this connection will be** — named for the client, with a scope picked from their
connections — or name an agent they already have. The client is issued tokens **whose subject is
that agent**: every MCP call it makes from then on is that agent's, with its scope, its working set,
its approvals and its history; the agent's row records which client it was connected from.
Revoking the agent revokes the grant; the client's next call is refused and it must reconnect.
Tokens refresh without the person for as long as the agent lives.

**Graft is its own authorization server**, written for this and nothing more: `@graft/core`'s
`mcp-oauth.service.ts` and `apps/server/src/mcp-oauth.ts`. Tokens are **opaque, hashed at rest**, in
one table for both kinds, exactly as the static agent token has always been stored; the MCP door
tells the two shapes apart by prefix (`grft_` and `grfta_`) and resolves both to one agent. No
environment variable is added: the issuer is `GRAFT_AUTH_URL`'s origin and the consent page is
`GRAFT_CONSOLE_URL`'s.

**The static bearer token stays**, untouched, beside it (ADR 0007). Hermes and OpenClaw carry a
header from a config file and have no browser to send anyone to; a chat product has a browser and
no config file. Two doors, one agent behind each.

## Why the agent, not the person, is the token's subject

A person is one account with many agents (ADR 0007); a token that named the person would name all
of them and none. Every scoped read in the schema takes the pair `(person, agent)` in the statement
(`repo/scope.ts`), every approval is per agent (ADR 0008), every working set is per agent
(ADR 0003) — so a person-subject token would have had to be *translated* into an agent on every
request, in a lookup keyed on something the protocol does not carry, and the revocation of that
translation would have been a second thing to get right. With the agent as subject, the consent is
the only place the choice is made, `requireAgent` is the only place a token becomes a scope, and
revoking the agent is the one act that ends the connection — as it always was for a static token.

## Considered options

- **Better Auth's OAuth provider** (`@better-auth/oauth-provider` with `@better-auth/mcp`, which
  is what the ticket's "MCP plugin over the OIDC provider" became in 1.7; the OIDC provider plugin
  no longer exists). Read in full from the 1.7.2 tarballs before this was written, and rejected on
  five counts. Its token's subject is the *person* — Better Auth's user — so the agent would have
  been the side table described above, and the agent's revocation would have had to reach into
  five of the plugin's tables to be complete. Its schema is eight tables, one of forty columns,
  which the `@better-auth/cli` pinned in `generate-schema` predates and which Graft would carry
  mostly unread. Its issuer is Better Auth's base path (`…/api/auth`), not the origin the ticket
  and the products expect. It brings DPoP, back-channel logout, end-session, introspection,
  client management, private-key JWT and Client ID Metadata Documents — some 320 KB of minified
  code on the authentication path that nobody here can read when it misbehaves. And the JWT
  access token it prefers cannot be revoked before expiry, which is the property a revoked agent
  most needs. The hand-built server is about six hundred lines with its tests, all of them
  readable.
- **A signed access token** (an HMAC JWT under `GRAFT_AUTH_SECRET` naming the agent) with an opaque
  refresh token. Rejected for the same reason: a stateless token cannot be revoked, and the door
  would have had to read the agent row on every request anyway — which is the lookup an opaque
  token already is.
- **Mint a static token for the OAuth agent too**, so the row's `token_hash` stays `NOT NULL`.
  Rejected: a token nobody was ever shown is a credential with no holder, and the column's
  reason for being is that the token was shown once. The column is nullable instead, and the
  console shows the client's name where it would show a prefix.
- **A token per person, one agent shared by every chat product.** Rejected: two connectors from
  one product are two grants, and the grain a person revokes at is the grant. Every registration
  is a row, every consent an agent.

## What Graft implements, and what it does not

Implemented, because the products need it: RFC 8414 and RFC 9728 metadata at the origin's
`/.well-known/` (the resource document in both forms the RFC admits, since the endpoint has a
path); RFC 7591 dynamic registration, unauthenticated, with `none`, `client_secret_basic` and
`client_secret_post`; the authorization code grant with PKCE `S256` **required** — `plain` is not
offered and a request with no challenge is refused; RFC 8707 `resource`, which must be the MCP
endpoint's canonical URL when sent and is bound to the token regardless; refresh with rotation,
one successor per predecessor — the claim is a guarded update inside the transaction that mints
the pair, so two refreshes racing on one token yield one — and a rotated token presented again
within thirty seconds is **answered the same pair**, opened from a seal kept on the retired row
under a key derived from the retired token itself (`mcp-oauth.replay.ts`: only its holder can
open it, the database alone cannot, and that holder could have refreshed a moment earlier anyway),
so a client that lost the response to a successful refresh recovers without the person; past
thirty seconds the same presentation is a replay that revokes the grant (OAuth 2.1 §4.3.1). A
code spent twice, racing or not, revokes the grant it
opened (RFC 6749 §4.1.2), and a code whose agent was revoked since the consent is refused; RFC 7009
revocation; RFC 9207's `iss` on every redirect; exact-match redirect URIs, `https` or loopback
`http` only, and no redirect to a URI the server has not confirmed (OAuth 2.1 §4.1.2.1 — those
requests land on the console as a refusal instead).

Not implemented, on purpose: OpenID Connect (no `id_token`, no `userinfo`, no
`/.well-known/openid-configuration` — a document missing the fields that RFC requires would break a
strict client where a 404 makes it fall back correctly); `client_credentials` and the device grant
(nothing acts as Graft without a person's consent); introspection (the door is the only verifier
and it reads the table); DPoP and Client ID Metadata Documents (neither product requires them);
RFC 8252 §7.3's loopback port variance (a client that varies its port registers each); a meaning
for the OAuth `scope` string (Graft's scope is the agent's connections, chosen on the consent page;
the string is stored and echoed).

## Consequences and accepted risks

- **Registration is an open, unauthenticated write.** Every product registers before any person
  is involved, so it has to be. A registration is one small row that binds to nothing until a
  consent does, and it is bounded — a 16 KB body, ten redirect URIs of 2 KB, a hundred-character
  name — so one caller cannot make the server store something large; the remaining risk is volume,
  and the mitigation when it is needed is a rate limit at the edge, not a change to the protocol.
- **A revoked agent's tokens die at once, and its client is told to reconnect.** The door's read
  joins `agent.revoked_at IS NULL`, so no token row needs touching for the refusal — they are
  stamped in the same transaction anyway, so the record says what happened. The refresh then
  answers `invalid_grant`, which the SDK's client turns into a fresh authorization, which the
  product turns into "reconnect".
- **An access token is an hour long** and the refresh token has no expiry of its own. The
  specification's "short-lived" is the hour; "for as long as the agent lives" is the refresh.
  Dead access tokens and expired codes are deleted a day later, on the way past a refresh, and a
  retired refresh token's seal is cleared then too; refresh tokens are kept in every state as the
  grant's record.
- **The consent page is the console's** (ADR 0006), drawn with its design system (ADR 0017), under
  its guard — so a person with no account yet creates one on the way and comes straight back.
  The authorization endpoint judges the request before sending the browser there, and the consent
  judges it again from the parameters the page hands back; the page is not trusted to have kept
  them honest.
- **The agent table's two token columns are nullable now**, and every reader of `tokenPrefix` in
  the console says what to show instead. A static token's lookup compares against `NULL` and
  matches nothing, which is the behaviour wanted.
- **The docs page for the products is written ahead of verification.** Connecting the real
  Claude.ai and ChatGPT accounts is Aleks's step once the server is deployed, and the page says
  where a step could not be checked.
