# Modern inventory for Graft (GRA-5, GRA-3)

Read against `docs/adr/0010-an-sdk-reaches-a-vendor-through-the-proxy-or-not-at-all.md`. All Modern paths are relative to a Modern checkout; all Cando paths relative to a Cando checkout. Written by a read-only research agent on 2026-09-09 and saved by the orchestrator.

## Section 1 — GRA-5, multi-host forwarding

### Modern's forward proxy as built

**Surface.** `apps/proxy/src/index.ts:20` mounts `forwardAuthMiddleware` on `/forward/*`; `:88` mounts `app.all('/forward/*', forwardHandler)`. A separate JSON endpoint, `POST /proxy` (`index.ts:19,22-86`), is the non-SDK path.

**URL grammar.** `/forward/<host>/<path>` (`forward-handler.ts:27-28`). Parsing is three lines: strip the prefix (`:39`), prepend `https://` (`:44`), `new URL` (`:46-50`). Empty remainder → 400 `Missing upstream URL in path` (`:40-42`); unparseable → 400 `Invalid upstream URL in path`.

**Host validation.** A module-level `ALLOWED_FORWARD_HOSTS` set (`forward-handler.ts:13-19`) holds four literals — `api.linear.app`, `api.notion.com`, `graph.facebook.com`, `api.airtable.com` — with a comment telling you to add more. `targetUrl.hostname` not in the set → 403 `Upstream host is not allowed` (`:53-56`). This is **global**, not per-credential: any caller with a valid proxy JWT and any credential id may reach any allowlisted host.

**Query.** Copied with `append`, not `set` (`:58-65`), so repeated params survive — the comment cites Airtable batch delete sending `records[]=…` twice.

**Credential lookup.** The credential id arrives in `INTEGRATION_ID_HEADER` = `x-integration-id` (`packages/common/src/proxy-headers.ts:10`), read at `forward-handler.ts:68`; missing → 400. It is resolved by `connectionsClient.getCredential(credentialId)` (`:76-82`), a contracts client built in `credential-fetcher.ts:13-21` against `env.API_URL` with Zitadel service-user auth. Failure → 500 `Failed to fetch credentials`. The response carries `{ credential, provider, integration }`.

**Header stripping.** `forward-handler.ts:86-99` iterates `c.req.raw.headers` (a real `Headers`, for multi-value fidelity) and drops `x-integration-id`, `x-proxy-auth`, `host`, `connection`, `transfer-encoding`. Notably it does **not** strip inbound `Authorization` — the injector overwrites it instead (`auth-injector.ts:150`) — and does not strip cookies, `accept-encoding`, `traceparent` or `x-forwarded-*`.

**Injection.** `injectAuth` (`auth-injector.ts:11-20`) = `applyAuth` + `applyRequestHeaders`.

- Dispatch on `provider.tokenConfig` (`:36-97`); absent → `AuthInjectionError` (`:33`).
- **Snowflake key-pair JWT** (`:48-60`): `signSnowflakeJwt` then formatted as bearer.
- **basic** (`:62-76`): username from `integration.config` then `credential.data`, password the reverse; base64 of `user:pass`.
- Otherwise the token is `resolveApiKey` (`:177-192` — first `secret: true` provider parameter present on the credential, else `credential.data.apiKey`) or `resolveAccessToken` (`:194-202` — `accessToken` or `access_token`).
- Per-credential overrides for api-key providers: `apiKeyHeader` overrides `tokenConfig.headerName` (`:85-88`), `apiKeyScheme` overrides the bearer prefix (`:89-92`).
- `formatTokenValue` (`:160-170`): `bearer` → `` `${scheme ?? 'Bearer'} ${token}` ``, `basic` → `Basic …`, `token`/default → raw.
- `applyTokenLocation` (`:141-158`): header (default `Authorization`, `set` not `append`) or query (`access_token` when bearer, else `token`).
- `applyRequestHeaders` (`:99-139`) then sets provider-declared extra headers sourced from `config`, `credential` or `static` with a `defaultValue` fallback. This is how Snowflake's `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT` arrives (asserted at `auth-injector.test.ts:78`).

**Snowflake recipe** (`snowflake-jwt.ts`): claims documented `:10-14`; `iss = <ACCOUNT>.<USER>.SHA256:<base64(sha256(DER spki))>` built at `:62`, fingerprint at `:173-178`; 50-minute lifetime with 60-second refresh skew (`:17-19`); RS256 signed by hand (`:93-99`); cached per `credential.id` keyed additionally by a SHA-256 content signature over account+user+PEM so a key rotation invalidates immediately (`:21-32,:46-51,:85-87`); `loadPrivateKey` (`:104-131`) tries the PEM as-is first and only then rebuilds it, with `rewrapCandidates` (`:154-166`) refusing to touch `Proc-Type`/`DEK-Info` encrypted PEMs; `normalizeAccount` (`:185-188`) strips a pasted `.snowflakecomputing.com` host and uppercases.

**Body and response.** No body read for `GET`/`HEAD`/`DELETE` (`:104-107`). The response is returned verbatim: status and headers copied minus `transfer-encoding`, `connection`, `content-encoding`, `content-length` (`:115-130`). The comment at `:116-117` is the load-bearing bit — **Node's fetch auto-decompresses, so a forwarded `Content-Encoding` would make the client try to inflate plain bytes, and `Content-Length` describes the compressed size.** Cando reached the same conclusion independently at `packages/proxy/src/headers.ts:106-113`.

**Wrapping.** `/forward` does not wrap. The other endpoint does: `executor.ts:2-11` returns `{status, headers, body}`, and `packages/integrations/src/http.ts:11-17` `unwrapResponseBody` peels that envelope for hand-written integrations. SDK clients need no unwrap, which is why the forward path exists at all.

**Proxy authentication.** `forward-auth.ts:25-47`: the JWT rides in `X-Proxy-Auth: Bearer …` (`proxy-headers.ts:13`) so it does not collide with the SDK's own `Authorization`; the middleware temporarily writes it into `Authorization`, calls the shared Zitadel introspection middleware, and restores the original inside the `next` callback (`:31-43`). Missing or non-Bearer → 401. Note this is a **network introspection call per request**.

**Status codes.** 400 (bad path, missing `x-integration-id`, `AuthInjectionError`), 403 (host), 401 (proxy auth), 500 (credential fetch), 502 (anything else).

**Tests.** `forward-handler.test.ts` (110 lines) mocks the credential fetcher and stubs global fetch; three cases at `:64` (allowlisted host, real PAT injected, proxy headers stripped), `:89` (non-allowlisted still 403), `:99` (repeated query params preserved). `auth-injector.test.ts` (92 lines): bearer scheme resolution `:37,:42,:47`; Snowflake `:78,:87`. `snowflake-jwt.test.ts` (211 lines): 19 cases, `:149-200` all PEM-mangling variants.

### What each side has that the other does not

Modern has, Cando lacks: **multi-host routing by path segment**. Cando's connection carries exactly one `baseUrl` (`packages/proxy/src/types.ts:50`) and `resolveTarget` (`app.ts:430-443`) refuses anything that moves off it. Modern also has a provider-registry-driven injector with per-credential header/scheme overrides, and the Snowflake key-pair recipe, which Cando has no scheme for.

Cando has, Modern lacks:
- **Capability token**, stateless EdDSA, with `sub`/`org`/`app`/`tool`/`dryRun` claims, verified at `app.ts:273-291`, read from three positions (`token.ts:16-31`), published JWKS at `app.ts:103-112`. Modern's per-request introspection is both slower and coarser.
- **Per-connection host pinning** plus agent/app match (`app.ts:299-325`).
- **Dry run** (`dry-run.ts:23,34,41-45,56-96`; interception at `app.ts:361-370`, deliberately before the credential is obtained).
- **Redirect refusal** by default (`redirects.ts:17,25-45,55-75`), plus `scrubReturnedRedirect` (`:83-99`) so a scheme's query key does not leak in a returned `Location`.
- **Private-range refusal at DNS resolution** (`upstream.ts:26-34,51-63`), closing the rebind window; `redirect: "manual"` always (`:71-92`); literal check via `public-host.ts:158,176`.
- **Far stricter header hygiene** (`headers.ts:11-97`): inbound auth headers and cookies, hop-by-hop, framing, `traceparent`/`tracestate`/`baggage`, the `x-forwarded-*`/CloudFront/ALB set, and the `proxy-`/`x-blaxel-`/`cloudfront-` prefixes; `accept-encoding: identity` forced.
- **One wide event per call** (`types.ts:234-272`, emitted at `app.ts:189-238`), body caps and a single call deadline (`app.ts:254-353`), and OAuth2 client-credentials derivation with cache and 401 retry (`schemes.ts:271`).

### Recommended merge

1. **Widen the connection to a host set.** `ProxyConnection.baseUrl: string | null` (`types.ts:50`) becomes a primary base URL plus an ordered `additionalHosts`; `CredentialSource` (`credential-source.ts:28-35`) and `BrokeredDefinition` (`types.ts:61-65`) carry the same. The primary is what `/c/<connection>/<vendor path>` still resolves against, so nothing already written breaks.
2. **Add the explicit form** `/c/<connection>/h/<host>/<vendor path>`, registered beside the two existing routes (`app.ts:116-117`). Use a literal marker segment rather than sniffing whether the first segment looks like a hostname — Modern gets away with sniffing only because its prefix is unambiguous. Refuse a host not in the connection's set with a `host_not_in_set` refusal alongside the existing `bad_target` (`app.ts:317-320`).
3. **Change only `resolveTarget`.** It takes the chosen host's base instead of `source.baseUrl` and keeps its post-hoc `url.host !== base.host` assertion (`app.ts:441`). Every other rung is untouched: dry run, redirects, private ranges, wide events keep working unchanged, which is the whole argument for merging inward rather than porting Modern's handler. Add `host` to `ProxyEvent` (`types.ts:234-272`) and to `DryRunPreview` (`dry-run.ts:56-68`).
4. **Widen `followable`** (`redirects.ts:55-75`) from "same host as base" to "any host in the connection's set" — still not an open redirect.
5. **Lift as code:** `apps/proxy/src/snowflake-jwt.ts` whole, re-expressed as a `snowflake_keypair_jwt` `SchemePlugin` (`schemes.ts:210`) whose `derive` returns the JWT and whose `apply` sets `authorization` plus the token-type header — with the cache moved from the module-level `Map` (`snowflake-jwt.ts:32`) into Cando's `DerivedCredentialCache` (`cache.ts`), keeping the content-signature invalidation (`:85-87`) and the PEM tolerance (`:104-166`) verbatim. Both are hard-won and Cando has nothing like them.
6. **Re-express, do not lift:** `auth-injector.ts`'s `tokenConfig` dispatch is Modern's provider-registry shape. Cando's `SCHEMES` already covers header (`schemes.ts:216`), query (`:228`), bearer (`:243`), basic (`:253`) and the prefix case. The only genuinely missing behaviour is the per-credential override pair (`auth-injector.ts:85-92`), and in Cando that belongs in `schemeConfig`, not on the credential.
7. **Do not lift:** `forward-auth.ts` (per-request Zitadel introspection — Cando's stateless verification is strictly better) or `credential-fetcher.ts` (Cando's `credentialSource` already splits held from brokered). The repeated-query-param fix (`forward-handler.ts:58-65`) is unnecessary: Cando assigns `url.search` wholesale (`app.ts:439`).

## Section 2 — GRA-3, SDK rebinding and the authoring skill

### Modern's recipe, exactly

**Constants** (`packages/common/src/proxy-headers.ts`): `INTEGRATION_ID_HEADER = 'x-integration-id'` (`:10`), `PROXY_AUTH_HEADER = 'x-proxy-auth'` (`:13`), `PROXY_PLACEHOLDER_API_KEY = 'proxy-will-inject-real-key'` (`:16`).

**Shared helpers** (`packages/integrations/src/shared/sdk-proxy.ts`): `buildProxyForwardUrl(proxyUrl, realUrl)` (`:10-15`) turns `https://api.linear.app/graphql` into `{proxyUrl}/forward/api.linear.app/graphql` — it reads `url.host` and `url.pathname` only, so any query on the real URL is silently dropped. `getSdkProxyConfig(providerName)` (`:21-38`) resolves the execution context, throws if `ctx.proxyUrl` or `ctx.proxyAuthToken` is missing, and returns `{ctx, integrationId, proxyUrl, proxyAuthToken}` where `proxyAuthToken` is an async function.

**Four SDKs, four ways to attach headers:**

| SDK | Base URL option | Placeholder slot | Headers |
| --- | --- | --- | --- |
| `@linear/sdk` (`linear/client.ts:25-31`) | `apiUrl` | `apiKey` | `client.client.setHeader(k, v)` |
| `@notionhq/client` (`notion/client.ts:29-40`) | `baseUrl` | `auth` | a `fetch` wrapper — no headers option exists |
| `airtable` (`airtable/client.ts:26-33`) | `endpointUrl` | `apiKey` | `customHeaders` |
| `facebook-nodejs-business-sdk` (`meta-ads/client.ts:35-102`) | none — subclass | `?access_token=` query | set inside the overridden `call()` |

Meta is the instructive failure. The subclass exists because the SDK hard-codes the host behind a static `GRAPH` getter, offers no transport hook, and puts auth in the query string (`meta-ads/client.ts:22-33`). The placeholder rides in the query and Modern's injector swaps it via `tokenConfig.location === 'query'` (`auth-injector.ts:154-157`). Instances are bound per call through `AbstractCrudObject`'s fourth positional argument rather than `FacebookAdsApi.setDefaultApi()`, because that static is process-level and concurrent runs would clobber each other (`meta-ads/client.ts:120-133,146-154`).

Airtable has a second trap: `patches/airtable@0.12.2.patch` exists because `lib/run_action.js` builds its headers without `_customHeaders`, so record CRUD silently dropped both proxy headers and 401'd in production. Any header-based proxy protocol is one un-audited SDK code path away from this.

**The caching caveat** is stated identically in all four factories — `linear/client.ts:16-18`, `notion/client.ts:20-22`, `airtable/client.ts:17-19`, `meta-ads/client.ts:131-132`: the proxy auth JWT is resolved eagerly (`await proxyAuthToken()`) and baked into the client, so a cached client outlives its token. Every action's `run()` must call the factory fresh.

**Test patterns** (`packages/integrations/src/linear/__tests__/`): `client.test.ts` mocks the SDK module (`:5-13`), builds an `ExecutionContext` with `integrations.linear.integrationId`, `proxyUrl` and a stubbed `proxyAuthToken` (`:21-30`), runs under `runWithContext`, then asserts the **exact** constructor argument object including the literal placeholder and the fully-built forward URL (`:39-42`), each header call (`:45-55`), and that the token was fetched once (`:57-61`). `sdk-actions.test.ts` uses `vi.hoisted()` for a mock bag (`:6-24`), `vi.mock('../client')` to return it (`:26-28`), then asserts per action which SDK method was called with what (`:55-93`).

**The existing skill** is `.claude/commands/create-sdk-integration.md` (116 lines): install into both `@modern/integrations` and `@modern/action-runner` with the esbuild externals rationale (`:11-16`), the directory shape (`:18-27`), a `client.ts` template (`:29-58`) that admits at `:51-52` that header attachment "varies by SDK — check how to set custom headers", the action pattern (`:60-75`), the subpath export (`:87-95`), the three test files (`:97-100`), and the `AVAILABLE_PROVIDERS` registration (`:102-104`).

### The recipe Graft's skill should teach

In ADR 0010's terms: **construct the SDK with the fixed placeholder credential and `ctx.proxyBase(host)` as its base; never set a real credential; never compute the base at run time.**

One substantive simplification over Modern. Modern needs two custom headers because the credential slot holds a dead placeholder and the *real* identity travels beside it. Cando reads its capability token from `Authorization: Bearer`, a raw `Authorization`, `x-api-key` or `x-cando-token` (`packages/proxy/src/token.ts:16-31`), and names the connection in the path. So in Graft **the placeholder credential can be the capability token itself** — `apiKey: ctx.proxyKey`, `base: ctx.proxyBase(host)` — and three of the four SDKs above need no custom headers at all, the Airtable patch becomes unnecessary, and the Notion fetch wrapper collapses to nothing. The checker rule stays mechanical: match the constructor's credential argument against the `ctx` identifier rather than against a string literal.

Per SDK family, base-URL option and header hook. Verified against the Modern checkout's `node_modules/.pnpm` unless marked otherwise.

- **`@linear/sdk` 75.0.0** — verified `dist/index.d.mts:13` (`apiUrl?: string`), `:126` `setHeaders(...)`, `:130` `setHeader(key, value)`. `new LinearClient({ apiKey, apiUrl })`; headers via `client.client.setHeader`.
- **`@notionhq/client` 5.10.0** — verified `build/src/Client.d.ts`, `ClientOptions` = `auth`, `timeoutMs`, `baseUrl`, `logLevel`, `logger`, `notionVersion`, `fetch`, `agent`, `retry`. No headers option; the `fetch` option is the only hook.
- **`airtable` 0.12.2** — verified `lib/airtable.d.ts:43-44` (`customHeaders?`, `endpointUrl?`) and `lib/airtable.js:24-28`. `customHeaders` is unreliable on record CRUD without the patch.
- **`@slack/web-api` 7.15.1** — verified `dist/WebClient.d.ts:18` (`slackApiUrl?`), `:162` (constructor accepts `headers`, `requestInterceptor`, `allowAbsoluteUrls`). `new WebClient(token, { slackApiUrl, headers })`. Set `allowAbsoluteUrls: false` (documented `:30-31`, `:143-144`) so an absolute method name cannot escape the proxy base — a checker-relevant detail ADR 0010 does not yet mention.
- **`stripe` 22.6.1** — verified against the copy in Cando's `node_modules` (`esm/lib.d.ts:14-98`): `StripeConfig` exposes `host`, `port`, `protocol` and an `httpClient` hook, but **no base path and no headers option**. A `/c/<connection>/<host>/<path>` prefix is therefore inexpressible; Stripe needs either a path-free proxy form or a custom `httpClient`. Flag it in the skill as a known exception.
- **`facebook-nodejs-business-sdk` 24.0.1** — present; Modern's subclass (`meta-ads/client.ts:35-102`) is the only known technique.
- **`googleapis` and `@octokit/rest`** — **unverified**: neither is installed under the Modern checkout's `node_modules`, the Cando worktree, or the Graft checkout. ADR 0010 asserts `rootUrl` for Google's clients and `baseUrl` for Octokit; Octokit is additionally documented to accept `headers` and `request.fetch`. Confirm both against the packages before the skill ships.

Carry forward from Modern's tests as the skill's required output: assert the exact constructor argument object with the literal placeholder and the fully-built proxy base (`client.test.ts:39-42`), and mock the client module wholesale for action tests (`sdk-actions.test.ts:26-28`). Carry forward the "do not cache the client" rule, restated for Graft as *the capability token is per-exec, so the client is per-exec*.

## Orchestrator's decisions on this inventory (2026-09-09)

- **Adopt the marker segment**: the proxy path becomes `/c/<connection>/h/<host>/<vendor path>`; the existing `/c/<connection>/<vendor path>` keeps resolving against the primary host.
- **Adopt the capability token as the placeholder**: the runner's context exposes `proxyKey` (the per-exec capability token) beside `proxyBase(host?)`; an SDK is constructed with `apiKey: ctx.proxyKey` and its base at `ctx.proxyBase(host)`; the proxy already reads the token from `Authorization`, so no custom header protocol is needed. The check matches the credential argument against the `ctx.proxyKey` identifier and the base against a `ctx.proxyBase(...)` call. ADR 0010 is to be amended by the GRA-3 PR with a paragraph recording this refinement and the risk it inherits from Cando's ADR 0025 (the token is printable by model code, bounded to one exec, one connection, minutes).
- **Slack**: the skill and the check treat `allowAbsoluteUrls: false` as required when the SDK is `@slack/web-api`.
- **Stripe**: a known exception; the skill says to write raw calls through `ctx.fetch` for Stripe until a custom `httpClient` recipe exists.
- **Lift Snowflake's key-pair JWT scheme** into Cando's `SchemePlugin` shape in GRA-5, cache in `DerivedCredentialCache`.
- **Do not lift** `forward-auth.ts`, `credential-fetcher.ts`, the global host allowlist, or the two-header protocol.
