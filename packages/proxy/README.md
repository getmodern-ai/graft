# @graft/proxy

The credential-injecting reverse proxy — the one route from a sandbox to a vendor (`CONTEXT.md`,
*Proxy*; ADR 0010 for why an SDK goes through it too). Copied from Cando's proxy package and
re-read on the way in (ADR 0011); the Snowflake scheme is Modern's, re-expressed as a plugin.

Sandbox code calls `/c/<connectionId>/<vendor path>` — or `/c/<connectionId>/h/<host>/<vendor
path>` for a declared host other than the primary — presenting a short-lived capability token
wherever an SDK would put an API key. The proxy verifies the token, checks the connection belongs to
the token's person and is named in the token, strips every inbound credential-shaped header and the
token itself from any other position it rode in, decrypts the connection's credential, applies the
connection's **scheme plugin**, forwards to the resolved host and nowhere else, and hands back the
vendor's status, headers and body verbatim. Every call writes one wide event — ids, host, method,
path, statuses, latency, byte counts — and never a header, a body or a query value.

## The boundary

This package knows only a **connection**, its **scheme**, its **host set** and a **token**. A person
and an agent reach it as ids on the token — the person compared against the connection's owner
(`person_mismatch`), the agent carried onto the wide event — and it knows nothing of what either
*is*, nor of a toolbox, a working set or an approval, and depends on nothing in any other `@graft/*`
package. Everything Graft-shaped is injected through `ProxyDeps`:

| Dep | What the host binds it to |
| --- | --- |
| `verifyToken` | `@graft/token`'s verifier — jose EdDSA over the deployment's public key |
| `jwks` | the same public key, as an RFC 7517 key set for `/.well-known/jwks.json` |
| `connections.get` | one unscoped row read; the proxy scopes it against the token's claims |
| `decryptCredential` | `@graft/vault`'s decrypt half |
| `upstreamFetch` | defaults to undici with a resolver that refuses private addresses |
| `log` | the request's wide event |

`apps/server/src/app.ts` is that binding, and mounts the app at `/api/proxy`. Moving the proxy to
its own service is a new host binding and a DNS change; nothing an agent wrote changes, because the
sandbox only ever knew the proxy's URL (GRA-1, "the proxy separable from the server by DNS alone").

What a dep throws reaches the wide event as its class name, never its message — `guardHostDeps` in
`failure.ts` wraps every host-bound function so the error the event describes is a
`HostDependencyError` naming the dependency and the class names down the thrown chain. The proxy
cannot know what a vault's message carries, so it records nothing it did not write itself; the host
may throw whatever is useful to it.

The package index exports what a host imports to mount the proxy and bind these deps, what the
runner and the check need to agree with it on, and what this README names — no more. Every module
is reachable by name through the package's `./*` export — `@graft/proxy/types` carries the rest of
the vocabulary, and `/public-host`, `/credential-fields` and `/cause-chain` are the tables a host
takes without the Hono app.

## The two path forms

A connection declares a **primary host** — a base URL, `https://api.vendor.example/v1` — and a set
of **hosts** it may reach, the primary's among them (ADR 0010: one Google connection reaches three
Google hosts, and the set is what the person saw on the handoff page).

| Form | Resolves to | For |
| --- | --- | --- |
| `/c/<id>/<path>` | the primary's origin and base path, then `<path>` | `ctx.fetch` in an authored module |
| `/c/<id>/h/<host>/<path>` | `https://<host>/<path>`, `<host>` in the set | an SDK constructed with `ctx.proxyBase(host)` as its base |

The explicit form never prepends the primary's base path: an SDK knows its own paths. A host
outside the set is refused `403 host_not_in_set`; the marker with nothing after it is refused the
same way. `h` is a literal marker rather than a guess at whether a segment looks like a hostname, so
the two forms cannot be confused — at the price that a vendor path whose first segment is `h` is
reachable only through the explicit form, `/c/<id>/h/<primary host>/h/...`. `proxyPathFor(id,
host?)` builds either form and is what the runner's `ctx.proxyBase` and the check use.

## The token is the placeholder credential

An SDK is constructed with the capability token as its API key and the proxy as its base (ADR
0010). The proxy reads the token from five positions, in order: `Authorization: Bearer <t>`,
`Authorization: Basic base64(<t>:)` or `base64(:<t>)`, a raw `Authorization: <t>`, `x-api-key`,
and `x-graft-token`. A basic pair with both halves filled is somebody's real credential, not a
token, and falls through. The query string is not a position — a bearer credential in a URL is
logged by every intermediary — so an SDK that can only send its key as a query parameter takes the
hand-written path.

Whatever position it rode in, the token reaches no vendor. The named positions and every other
credential-shaped header are stripped by name (`headers.ts`); then any remaining header or query
parameter whose value carries the token is dropped by value (`scrubToken` in `token.ts`); then the
scheme plugin writes the real credential into the position the vendor expects. `app.test.ts`
proves it for a header scheme, a query scheme and basic — the vendor receives the real credential
and never the token.

## Files

One module per question the proxy answers, so a change to one is made once:

| File | What it holds |
| --- | --- |
| `app.ts` | the Hono app; the two path forms (`routeOf`, `proxyPathFor`); the ladder (`decide`) — token, connection, person and scope, host, body cap, the dry-run rung — and the vendor leg (`forward`) as named steps: apply the scheme, send, refresh on 401, next hop, read, answer |
| `credential-source.ts` | `credentialSource` — the row's readiness, its host set (`hostSetOf`) and the decrypt — and `wireCredential`, the **stored** credential against what the scheme **derives** from it, with the cache and the 401 refresh |
| `redirects.ts` | `MAX_REDIRECT_HOPS`, `isRedirect`, `nextHop` and `followable` — the inside-the-host-set follow policy under the `followRedirects` break glass — and `scrubReturnedRedirect`, what a returned `Location` loses |
| `failure.ts` | `Refused` and `refuse`, `refusalBody` (`{ error, reason, message }`), `describeFailure` (the event's cause chain), `guardHostDeps` and `HostDependencyError`, and the refusals more than one rung shares |
| `schemes.ts` | the seven scheme plugins — `apply`, `headerNames`, and `derive` where the wire credential is derived — and their errors |
| `snowflake-jwt.ts` | Snowflake's key-pair JWT recipe and the PEM tolerance, the pure half of `snowflake_keypair_jwt` |
| `credential-fields.ts` | the import-free tables of fields each scheme reads, required and optional |
| `dry-run.ts` | the dry-run marker, the preview status, `isSafeMethod` and the preview, whose header names come from each scheme's `headerNames` |
| `headers.ts` | the outgoing and passthrough header policies |
| `token.ts` | where a capability token rides, which inbound headers are stripped, and the by-value sweep |
| `body.ts` | capped, deadline-bound body reads |
| `public-host.ts` | the address rule — which hostnames and literals a credential may be sent to |
| `upstream.ts` | undici behind the guarded resolver, and the private-address and timeout classifiers |
| `cache.ts` | the in-memory derived-credential cache |
| `cause-chain.ts` | the one cause-chain walker |
| `types.ts` | the vocabulary — `ProxyConnection`, `CapabilityClaims`, `ProxyDeps`, `ProxyEvent`, `ProxyOutcome` and the rest |
| `index.ts` | the package's exports |

## Scheme plugins

Seven schemes: `api_key_header`, `api_key_query`, `bearer`, `basic`, `oauth2_client_credentials`,
`unleashed_hmac` and `snowflake_keypair_jwt`. Authorization-code OAuth with a person-registered
client is GRA-30's.

Two derive their wire credential. `oauth2_client_credentials` holds a client id and secret and buys
an access token from `schemeConfig.tokenUrl` (client authenticated per `schemeConfig.clientAuth`,
`basic` by default or `body`; `schemeConfig.scopes` sent as `scope`), caches it per connection until
`expires_in` less a minute, and on a vendor 401 buys one more and retries the call once. The token
endpoint answers to the same public-address rule as the vendor. `snowflake_keypair_jwt` holds a
private key (`privateKey`, with `privateKeyPassphrase` when the PEM is encrypted), reads the account
and user from `schemeConfig`, signs the RS256 JWT Snowflake's key-pair authentication wants, sends
it as a bearer beside `x-snowflake-authorization-token-type: KEYPAIR_JWT`, caches it for its life
less a minute, and drops it early when the account, user or key on the row changes. A pasted key
that lost its line breaks is repaired; an encrypted PEM is never touched.

`unleashed_hmac` is the worked example of a signing recipe: `api-auth-signature` is the base64
HMAC-SHA256 of the query string (after `?`, empty when none) keyed by the API key, beside
`api-auth-id` and `client-type: graft/agent`.

The credential field names each scheme reads live in `credential-fields.ts`, on their own and
import-free, because the console reaches that table while `schemes.ts` imports `node:crypto`.
`schemes.test.ts` holds each plugin to its row.

## Dry runs

A capability token may carry `dryRun: true` (`CONTEXT.md`, *Dry run*). With it, the proxy runs
every check above — token, connection, person and scope, host set, private ranges, the body cap —
and then:

| Method | What happens | Answer |
| --- | --- | --- |
| `GET`, `HEAD` | forwarded to the vendor exactly as an ordinary call | the vendor's status, headers and body, plus `x-graft-dry-run: forwarded` |
| anything else | stopped here, **before** a credential is decrypted or a token exchanged or signed | `202 Accepted`, `x-graft-dry-run: intercepted`, and the preview below |

The preview is the request as it would have left, minus every value that is not the caller's to see:

```json
{
  "dryRun": true,
  "intercepted": true,
  "request": {
    "method": "POST",
    "host": "api.vendor.example",
    "path": "/v1/orders",
    "hasQuery": false,
    "headerNames": ["accept", "accept-encoding", "content-type", "x-demo-key"],
    "bodyBytes": 27,
    "body": "{\"lines\":[{\"sku\":\"A\",\"qty\":2}]}",
    "bodyEncoding": "utf-8"
  }
}
```

`host` is the vendor hostname the request would have gone to and `path` the resolved path there;
`hasQuery` says whether a query string was present without repeating it. `headerNames` are the
names, sorted and lower-cased, of every header that would have gone out — the caller's after the
outgoing policy and the sweep, and the scheme's own as its plugin's `headerNames` lists them — by
name, never by value, and with no credential in hand. The body is the caller's, already read under
the proxy's cap, as UTF-8 when it decodes as such and base64 otherwise. 202 because RFC 9110
§15.3.3 defines it as *understood, not performed*: a 2xx so a module's `response.ok` check carries
on, and not 200, 201 or 204, so a status check for a completed write reads an honest no. The proxy
never fabricates a vendor response.

## Refusals

Every refusal is `{ error, reason, message }` with `reason` one of the `ProxyOutcome` words the
wide event carries: `token_missing`, `token_expired`, `token_invalid`, `person_mismatch`,
`connection_not_in_token`, `connection_unknown`, `connection_not_ready`, `credential_incomplete`,
`credential_unreadable`, `token_exchange_failed`, `bad_target`, `host_not_in_set`,
`host_not_public`, `request_too_large`, `request_timeout`, `response_too_large`,
`upstream_timeout`, `upstream_unreachable`, `proxy_unconfigured`, `proxy_error`. A vendor's own
error is not a refusal — it comes back as the vendor sent it. Two outcomes are not refusals either:
`forwarded` and `redirect_returned` are the vendor's answer passed through, and
`dry_run_intercepted` is the preview above.

## The wide event

One per call, refused or not: `outcome`, the proxy's `status` and the vendor's `upstreamStatus`,
`method`, the vendor `path` and `hasQuery`, `connectionId`, `personId`, `agentId`, `tool`, the
vendor `host` the call resolved to, `latencyMs`, `requestBytes` and `responseBytes`,
`redirectHops`, `failure` (a cause chain for the proxy's own errors and the network's; the
dependency and the class names for what the host's vault or store threw — never a stack or a body),
`dryRun` — whether the token carried the claim — and `dryRunOutcome`: `forwarded` once a dry-run
read has left for the vendor, `intercepted` for a write stopped here, `null` for an ordinary call or
one refused before the decision. Never a header, a body or a query value.

One deadline (thirty seconds by default) covers the whole call, from the caller's first body byte
to the vendor's last, so neither side can hold a connection and a buffer past it. Both bodies are
buffered under a cap (ten megabytes) so the wide event can carry exact byte counts and the cap can
be a clean refusal rather than a cut connection.

## Redirects

Not followed. A 3xx is returned to the caller with its `Location`, because following one is how a
credential leaves the host it was entered for. `options.followRedirects` is the break glass: on, a
redirect whose host is in the connection's set — the primary or any declared host — is followed, at
most three hops, with the credential re-applied per hop; a `Location` outside the set, on another
port, or downgraded from https is still returned.
