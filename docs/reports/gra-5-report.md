# GRA-5 report = PR #6 body (saved by the orchestrator 2026-09-09)

Closes GRA-5 — https://linear.app/get-modern/issue/GRA-5/the-proxy-reaches-a-vendor-through-a-host-segment-with-the-placeholder

## What

Cando's proxy, capability token and vault arrive as `@graft/proxy`, `@graft/token` and `@graft/vault`, with `@graft/env` (validated environment) and `@graft/server` (a minimal Hono server) around them. Copied and re-read per ADR 0011: every comment cites a Graft ADR or the spec, and no file names a Cando ticket or Cando ADR.

**Vocabulary and coupling.** `CANDO_*`/`x-cando-*`/`iss: "cando"` → `GRAFT_*`/`x-graft-*`/`"graft"`. `organizationId` is gone from `ProxyConnection`, `CredentialScope`, `ProxyEvent` and the claims; a connection carries `personId` (ADR 0007). `appSlug`, `claims.app` and `app_mismatch` are replaced by the token's `connections` list and a `connection_not_in_token` refusal; `agent_mismatch` becomes `person_mismatch` (the agent appears on the event only). Everything Pipedream/brokered is deleted.

**Host set (ADR 0010).** `ProxyConnection` carries `primaryHost` (a base URL) and `hosts` (hostnames). `/c/:connectionId/*` still resolves against the primary; `/c/:connectionId/h/:host/*` resolves against `https://<host>` from the root and is refused `403 host_not_in_set` outside the set. Only `resolveTarget` changed; its post-hoc host assertion stays. `followable` widens from same-host to any host in the set (same port, no https downgrade). `host` joins `ProxyEvent` and the dry-run preview. Private-range refusal and the undici DNS guard run for every host.

**The token is the placeholder credential.** Read from `Authorization: Bearer`, `Authorization: Basic base64(t:)`/`base64(:t)` (new), raw `Authorization`, `x-api-key`, `x-graft-token`. The named positions are stripped by name, then `scrubToken` drops any remaining header or query parameter whose value carries the token, then the scheme injects. Tests cover the token in a header position with a header scheme (writing the same header), a query scheme (with the token in the caller's query too) and basic.

**Snowflake.** Modern's `snowflake-jwt.ts` is lifted as the pure `snowflake-jwt.ts` plus a `snowflake_keypair_jwt` `SchemePlugin`: cached in `DerivedCredentialCache`, content-signature invalidation and PEM tolerance kept, `account`/`user` in `schemeConfig`, `privateKey` (+ optional `privateKeyPassphrase`) as the credential. `SchemeRuntime` gained `now` so the JWT's clock is the cache's. `unleashed_hmac` stays as the worked signing example with `UNLEASHED_CLIENT_TYPE = "graft/agent"`.

**Wide event.** One per call, unchanged shape plus `personId` and `host`, minus `organizationId`/`appSlug`. The server nests it under `proxy` on evlog's request event.

## Decisions

- **Vault keyring: `node:crypto` AES-256-GCM envelope behind a `Keyring` seam we own, not the AWS Encryption SDK.** `@aws-crypto/client-node` hard-depends on `@aws-crypto/kms-keyring-node` → `@aws-sdk/client-kms` (+ `client-dynamodb`), so keeping it would put the KMS client in the open repo's dependency tree even with only the raw AES keyring in use — a backing present by dependency rather than absent (ADR 0002). The seam is `{ id, generateDataKey(context), unwrapDataKey(wrapped, context) }`, which maps 1:1 onto KMS `GenerateDataKey`/`Decrypt` for GRA-20. Envelope: version, keyring id, canonical context JSON, wrapped data key (header, and the body's AAD), IV, tag, ciphertext. Context is compared before the keyring is asked and authenticated by both decrypts. Unwrapped data keys are cached five minutes so KMS is asked once per row.
- **Claims:** `person`, `agent`, `connections` (non-empty string array), `tool`, `dryRun` (present only when true), `exp`, `iat`, `jti`, `iss: "graft"`, `aud: "proxy"`. No `sub` — two principals, named as the glossary names them.
- **`@graft/token` is pure**: keys are arguments; `createCapabilityTokenVerifier(keys | null)` binds `verifyToken`/`jwks` for `ProxyDeps`. The server resolves keys from `@graft/env`.
- **`h` is a literal marker**, so a vendor path whose first segment is `h` is reachable only through the explicit form (`/c/<id>/h/<primary host>/h/...`). The explicit form never prepends the primary's base path: an SDK knows its own paths.
- **The query string is not a token position** (a bearer in a URL is logged by every intermediary); it is still swept by value.
- **`hostSetOf` adds the primary's hostname** to the declared set, so a row that omitted it still follows a redirect back to the host it was entered for.
- **Env:** `GRAFT_KEYRING_SECRET` required (32+); the key pair is all-or-nothing; `GRAFT_PROXY_PUBLIC_URL` defaults to `http://localhost:<PORT>/api/proxy`; `GRAFT_DEV_SEED` is refused under `NODE_ENV=production`. Rules live in a pure `schema.ts`; `server.ts` alone calls `createEnv`.
- **evlog** dropped in cleanly (`evlog/hono` middleware + `useLogger().set({ proxy: event })`), so the wide-event drain is the same tool Cando uses.
- **Catalog additions** (`pnpm-workspace.yaml`): `hono ^4.13.3`, `undici ^7.29.0`, `jose ^6.2.4`, `zod ^4.4.3`, `@t3-oss/env-core ^0.13.11`.

## The contract GRA-3 / GRA-18 build against

- Paths: `/c/<connectionId>/<vendor path>` (primary) and `/c/<connectionId>/h/<host>/<vendor path>` (declared host, origin only). `proxyPathFor(connectionId, host?)` from `@graft/proxy` builds both.
- Token positions: `Authorization: Bearer <t>`, `Authorization: Basic base64(<t>:)`/`base64(:<t>)`, `Authorization: <t>`, `x-api-key`, `x-graft-token`.
- Dry run: `x-graft-dry-run: forwarded | intercepted`, 202 preview with `request.host` and `request.path`.
- Refusal reasons (`{ error, reason, message }`): `token_missing`, `token_expired`, `token_invalid`, `proxy_unconfigured`, `bad_connection_id`, `connection_unknown`, `person_mismatch`, `connection_not_in_token`, `connection_not_ready`, `credential_incomplete`, `credential_unreadable`, `token_exchange_failed`, `bad_target`, `host_not_in_set`, `host_not_public`, `request_too_large`, `request_timeout`, `response_too_large`, `upstream_timeout`, `upstream_unreachable`, `proxy_error`.
- Wide event fields: `outcome, status, upstreamStatus, method, path, hasQuery, connectionId, personId, agentId, tool, host, latencyMs, requestBytes, responseBytes, redirectHops, dryRun, dryRunOutcome, failure` — never a header, body or query value.

## How verified

`pnpm run check`, `pnpm run lint`, `pnpm run check-types` (6/6), `pnpm run test --force` (`Cached: 0`): 430 tests — proxy 360 across 13 suites (app, schemes, snowflake-jwt, failure, credential-source, redirects, dry-run, public-host, upstream, cause-chain, body, token, cache), token 16, vault 23, env 11, server 17.

Dev-server smoke: `.env` from `pnpm --filter @graft/server keys`, three connections seeded from a JSON file (httpbin.org with `postman-echo.com` as a secondary host and an `x-demo-key` header scheme; the same vendor with the scheme writing `x-api-key`; and `http://127.0.0.1:9999`, a `node -e` fake upstream that logs anything it receives), tokens from `pnpm --filter @graft/server mint`. A local upstream is refused by the proxy's own private-range rule, which is why the injected header is shown through public echo services instead.

```
$ curl -s -i http://localhost:3050/api/proxy/c/httpbin/headers -H 'Authorization: Bearer $TOKEN'   # plain form, primary host
HTTP/1.1 200 OK
content-type: application/json
...
{
  "headers": {
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Host": "httpbin.org",
    "User-Agent": "curl/8.7.1",
    "X-Demo-Key": "sk_demo_real_vendor_key_0123456789"      <- the decrypted credential; no Authorization, no token
  }
}

$ curl -s http://localhost:3050/api/proxy/c/httpbin-apikey/headers -H 'x-api-key: $TOKEN'   # token in the very header the scheme writes
{ "headers": { ..., "X-Api-Key": "sk_demo_real_vendor_key_0123456789" } }   <- the real key, never the token

$ curl -s http://localhost:3050/api/proxy/c/httpbin/h/postman-echo.com/get -H 'Authorization: Bearer $TOKEN'   # explicit host form
{"args":{},"headers":{"host":"postman-echo.com",...,"x-demo-key":"sk_demo_real_vendor_key_0123456789",...},"url":"https://postman-echo.com/get"}

$ curl -s -i http://localhost:3050/api/proxy/c/httpbin/h/evil.example/get -H 'Authorization: Bearer $TOKEN'
HTTP/1.1 403 Forbidden
{"error":"forbidden","reason":"host_not_in_set","message":"The host in the path is not one the connection declares"}

$ curl -s -i -X POST http://localhost:3050/api/proxy/c/httpbin/post -H 'Authorization: Bearer $DRY' -H 'content-type: application/json' -d '{"order":1}'
HTTP/1.1 202 Accepted
x-graft-dry-run: intercepted
{"dryRun":true,"intercepted":true,"request":{"method":"POST","host":"httpbin.org","path":"/post","hasQuery":false,"headerNames":["accept","accept-encoding","content-type","user-agent","x-demo-key"],"bodyBytes":11,"body":"{\"order\":1}","bodyEncoding":"utf-8"}}

$ curl -s -i http://localhost:3050/api/proxy/c/httpbin/get -H 'Authorization: Bearer $OTHER'   # another person's token
HTTP/1.1 403 Forbidden
{"error":"forbidden","reason":"person_mismatch","message":"The connection belongs to another person"}

$ curl -s -i http://localhost:3050/api/proxy/c/local-fake/anything -H 'Authorization: Bearer $TOKEN'   # primary host is a private literal
HTTP/1.1 403 Forbidden
{"error":"forbidden","reason":"host_not_public","message":"The vendor host is not a public address"}

$ curl -s http://localhost:3050/api/proxy/.well-known/jwks.json
{"keys":[{"crv":"Ed25519","x":"jPtMdS1LMAUGIqU4qLg3kHedxzfRGjXd4FRjOl7QaoY","kty":"OKP","kid":"Cd6Q0PjMMnLMo8YY0oekP2kjiLLcjFlpHjvz80uyqRk","alg":"EdDSA","use":"sig"}]}

=== server stdout (evlog wide events; the proxy's event nests under proxy) ===
01:03:32.310 INFO [graft-server] GET /api/proxy/c/httpbin/headers 200 in 1.10s
  └─ proxy: method=GET path=/headers hasQuery=false connectionId=httpbin personId=person_demo agentId=agent_demo tool=execute host=httpbin.org dryRun=false latencyMs=1103.1 outcome=forwarded status=200 upstreamStatus=200 requestBytes=0 responseBytes=325 redirectHops=0
01:03:33.028 INFO [graft-server] GET /api/proxy/c/httpbin/h/postman-echo.com/get 200 in 433ms
  └─ proxy: method=GET path=/get hasQuery=false connectionId=httpbin personId=person_demo agentId=agent_demo tool=execute host=postman-echo.com dryRun=false latencyMs=432.8 outcome=forwarded status=200 upstreamStatus=200 requestBytes=0 responseBytes=280 redirectHops=0
01:03:33.043 INFO [graft-server] GET /api/proxy/c/httpbin/h/evil.example/get 403 in 1ms
  └─ proxy: method=GET path=/get hasQuery=false connectionId=httpbin personId=person_demo agentId=agent_demo tool=execute dryRun=false latencyMs=0.5 outcome=host_not_in_set status=403 redirectHops=0
01:03:33.058 INFO [graft-server] POST /api/proxy/c/httpbin/post 202 in 2ms
  └─ proxy: method=POST path=/post hasQuery=false connectionId=httpbin personId=person_demo agentId=agent_demo tool=execute host=httpbin.org dryRun=true dryRunOutcome=intercepted latencyMs=2.3 outcome=dry_run_intercepted status=202 requestBytes=11 responseBytes=260 redirectHops=0
01:03:33.072 INFO [graft-server] GET /api/proxy/c/httpbin/get 403 in 0ms
  └─ proxy: method=GET path=/get hasQuery=false connectionId=httpbin personId=person_other agentId=agent_x tool=execute dryRun=false latencyMs=0.4 outcome=person_mismatch status=403 redirectHops=0
01:03:33.086 INFO [graft-server] GET /api/proxy/c/local-fake/anything 403 in 1ms
  └─ proxy: method=GET path=/anything hasQuery=false connectionId=local-fake personId=person_demo agentId=agent_demo tool=execute host=127.0.0.1 dryRun=false latencyMs=0.4 outcome=host_not_public status=403 redirectHops=0

=== fake upstream log (must show no request) ===
[fake upstream] listening on 127.0.0.1:9999
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)


## Decisions in the code but not in the PR body (agent's closing note, 2026-09-09)

1. `SCHEME_OPTIONAL_CREDENTIAL_FIELDS` is a second import-free table exported from `@graft/proxy` (`{ snowflake_keypair_jwt: ["privateKeyPassphrase"] }`). The handoff form (GRA-28) must read both tables, not just `SCHEME_CREDENTIAL_FIELDS`.
2. An unparseable Snowflake private key throws `InvalidCredentialFieldError`, classified as a scheme-configuration error → `409 credential_incomplete` naming `privateKey`; no new `ProxyOutcome` word.
3. `PORT` is validated in `@graft/env` because `GRAFT_PROXY_PUBLIC_URL`'s default derives from it; the server reads `env.PORT`.
4. `@graft/server`'s `start` is `tsx src/index.ts`, no build step; GRA-33's Docker image will want a real build.
5. `ProxyEvent.host` is set the moment a target resolves, before the public-address check, so `host_not_public` records the host; earlier refusals (`host_not_in_set`, token and scope refusals) carry `host: null`.
