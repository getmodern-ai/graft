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
