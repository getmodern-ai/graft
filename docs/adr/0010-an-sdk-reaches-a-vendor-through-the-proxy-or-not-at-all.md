---
status: accepted
---

# An SDK reaches a vendor through the proxy or not at all

Cando's contract, inherited whole: **a module never holds a credential and its only route out is
`ctx.fetch` with a vendor-relative path**, which the proxy completes, signs and pins to the
connection's hosts. A vendor SDK does not know about `ctx.fetch`. So when the authoring model
reaches for one, **the SDK is constructed with a placeholder credential and the connection's proxy
URL as its base**, the proxy strips the placeholder and injects the real credential, and **the
static checker refuses a module whose SDK is not bound to the proxy or that sets a credential of
its own**. Google's client takes a `rootUrl`, Octokit a `baseUrl`, Slack's a `slackApiUrl`; most
REST-shaped SDKs expose the option.

Modern proved this pattern with Linear, Notion, Airtable and Meta Ads: a client factory hands the
SDK a placeholder key and a `/forward/<host>/<path>` proxy base, and a `create-sdk-integration`
skill generates new ones. One change on the way in: Modern trusts a global host allowlist, Cando
pins the host per connection, and an SDK such as Google's spans several hosts, so **a connection
declares the set of hosts it may reach and the proxy pins to that set**.

**Hand-written calls through `ctx.fetch` are the default. An SDK is the last resort**, chosen only
when the model can say why the raw calls are worse, because every package is attack surface the
proxy cannot see (ADR 0013).

## Considered options

- **`ctx.fetch` only, never an SDK.** Rejected as an absolute: some vendors are miserable without
  one, and the bet says the agent takes the efficient path. Kept as the default.
- **Credentials as data**, the token handed to the sandbox so SDKs work unchanged. This is
  executor.sh's rework decision D49. Rejected outright: model-written code can print the token, and
  the documentation page it just read is one prompt injection away from it; egress isolation
  becomes the only defence, and it is the defence the Docker form can least guarantee.
- **A TLS-terminating egress proxy** trusting a per-sandbox CA, injecting by host, for SDKs that
  hard-code their host. Roadmap, not rejected; Blaxel's own egress injection is this shape and is
  still in preview.

## Consequences and accepted risks

- **SDKs that hard-code their host or use gRPC cannot be used** until the TLS-terminating proxy
  exists. The model falls back to raw calls.
- **The dry run works unchanged**, because the SDK's calls still cross the proxy where the dry-run
  claim is enforced.
- **The checker's binding rule is mechanical and literal**: a placeholder in the constructor and
  `ctx.proxyBase` as the base. A module that computes its base URL at run time is refused, which is
  a deliberate false positive.

## Amended 9 September 2026

The placeholder credential is not a fixed constant but **the capability token itself**, exposed to
the module as `ctx.proxyKey` beside `ctx.proxyBase(host?)` (GRA-3). The proxy already reads the
token from `Authorization`, so an SDK constructed with `apiKey: ctx.proxyKey` and its base at
`ctx.proxyBase(host)` needs no custom header protocol, and the checker's rule matches the credential
argument against that identifier rather than against a string. The module holds nothing longer-lived
than the exec: the token is minted per exec, names one connection, and expires in minutes. The risk
class is the one Cando's ADR 0025 accepted — model-written code can print the token, and what it buys
is bounded to that connection for those minutes. Two SDK facts the checker and the skill carry:
`@slack/web-api` must be constructed with `allowAbsoluteUrls: false`, since it otherwise treats a
method name that is an absolute URL as the URL to call; and Stripe's SDK has no base-path option, so
Stripe is raw `ctx.fetch` for now.

## Amended 9 September 2026, second

**The proxy redacts an echoed credential by value on the way back** (GRA-29). A vendor that quotes
the key it refused in a 401 body, or echoes the request it was sent, would otherwise hand the
plaintext to the sandbox and on into `acquire`'s trace — and the proxy is the one component that
holds the plaintext at injection time (GRA-1, "The core and its seams"), so it is the only one that
can redact by value; everything downstream can redact only by shape. After injecting, the proxy
replaces every occurrence of each injected value — the stored fields, the derived wire credential,
and for basic auth the base64 pair the header carries — in response headers and in text-like bodies
(JSON, text, XML, HTML, a form, and their structured suffixes) with `[redacted:credential]`, sets
`x-graft-redacted: credential` on the response, and records `credentialEchoed` on the wide event.
Binary bodies pass through untouched, since a byte sequence that spells a key in an image is not an
echo. The consequence for a module: a vendor error it reads may carry the marker where the vendor
wrote the key, which is the one place "verbatim" gives way.

## Amended 17 September 2026

**A keyless connection is a connection all the same** (GRA-66). The proxy injects what the
connection's scheme says, and the scheme `none` says nothing: no credential is entered, none is
stored, and the request leaves as the module made it. Everything else this decision rests on is
unchanged for such a connection — the host set is pinned, egress is the proxy or nothing, the
public-address rule holds, a dry run intercepts writes, a redirect is handed back. The scheme
exists because the alternative, a placeholder credential for a public API, is not neutral: on
2026-09-17 Open-Meteo answered every request carrying an `apikey` — whatever its value — with a 303
to its paid host, and the first hosted `acquire` against it failed on that alone. A person confirms
a `none` connection in the console as any other, and enters nothing; consent still never moves
inside the loop.

## Amended 22 September 2026

**The body cap is a variable, and its default does not move** (GRA-181, GRA-183). The proxy
buffers both legs and caps them, and the constant behind that cap becomes
`GRAFT_PROXY_MAX_BODY_BYTES`, default the 10 MiB it always was, refused below 1 MiB, applied to a
request body and a response body alike, named on the boot line when it is not the default. The
buffering rationale stands: exact byte counts on the wide event, a clean refusal instead of a cut
mid-body, redaction by value over a whole text-like body. Raising the default was considered and
refused, since every tool would then hold larger bodies in memory per in-flight call and hand the
model bodies it cannot use. An operator whose tools move files larger than the default raises it
for that deployment; the blob store (ADR 0023) is what those files travel through afterwards.
Streaming the response leg with a redaction lookback is the shape that would remove the cap, and
is its own later decision.

## Amended 23 September 2026

**`ctx.fetch` takes an absolute URL on one of the connection's hosts, and the route is still the
proxy** (GRA-197). The contract above says a module's only route out is `ctx.fetch` with a
vendor-relative path, and the runner refused every absolute URL. A vendor whose write flow hands the
module an absolute URL on a second confirmed host could then not be authored without an SDK: Slack's
`files.getUploadURLExternal` answers an `upload_url` on `files.slack.com` for the bytes to be posted
to, the host was in the connection's set, and on 2026-09-23 three `acquire` jobs gave up on it (the
ticket has the three lines), one after `@slack/web-api`, bound as this decision says, retried the dry
run's 202 preview until the run timed out. Now the runner rewrites an absolute `https://` URL onto
the proxy's host form for its host, `/c/<connection>/h/<host>/<path>?<query>`, the same route
`ctx.proxyBase(host)` names for an SDK, so the proxy judges the host against the connection's
`hosts` exactly as it did and refuses one the person did not confirm with its existing
`host_not_in_set`. Nothing this decision rests on moves: the host set is still the connection's,
egress is still the proxy or nothing, the token still travels to the proxy alone, a redirect is
still handed back, and a relative path resolves as before. The runner refuses, before any request
leaves, a URL that is not `https:`, one carrying credentials, and one whose host is not a host name,
each with a sentence naming what was refused. The checker keeps refusing a *literal* absolute URL at
a `.fetch(` call, the smell it was; a presigned URL is a run-time value the check never sees, and
its sentence now says one may be passed as it is. What "hand-written calls are the default" gains: a
write flow across two of a connection's hosts is `ctx.fetch` twice, and the authoring skill says to
prefer that over an SDK for a write, since an SDK that retries on a body it does not expect times
out against the preview. Whether the preview should instead answer in a shape the common SDKs
accept is GRA-198's decision, not this amendment's.

## Amended 24 September 2026

**A declared host known in advance is named with `host`, on the same route** (GRA-213). The
amendment above gave a URL the vendor answers at run time a way onto the proxy's host form and left
a host the module knows when it is written with none: the check refuses a literal absolute URL,
`ctx.proxyBase(host)` is an SDK's base, and a proof read was a path on the primary host. On
2026-09-24 a job authoring an Open-Meteo city forecast gave up on exactly that, its forecast on
`api.open-meteo.com` and its city lookup on `geocoding-api.open-meteo.com`, both in the
connection's set. Now `ctx.fetch(path, { host })` takes a path from that host's root and the runner
sends it as it sends `https://<host><path>`, and `acquire`'s proof reads carry the same optional
`host`, refused by the job before any read when the connection does not declare it. What this
admits is one literal the checker used to have no reason to see: a host name in `fetch`'s init.
It is a selector among hosts the person confirmed, judged by the proxy against the connection's set
exactly as an absolute URL's host is, so the check lets it stand, and a literal absolute URL stays
refused. Nothing else moves: the host set is the connection's, the route is the proxy, and the
runner holds no host list.
