---
status: accepted
---

# OAuth clients belong to the person, and the agent guides their creation

Key-shaped authentication is inherited working from Cando: API keys in a header or query
parameter, bearer, basic, OAuth2 client credentials, and signing recipes such as Unleashed's HMAC.
For **authorization-code OAuth**, the kind Gmail, Slack user tokens and Notion need, Graft runs the
flow against **a client the person registers in the vendor's console**: client id and secret stored
beside the connection, PKCE and a signed state, refresh handled by Graft. The agent acts as the
guide: `acquire` reads the vendor's OAuth documentation and tells the person which console to open,
what to name the app and which redirect URI to paste, then hands off to the console (ADR 0006) for
the secret. Cando's wizard pattern is the precedent.

**Graft operates no first-party OAuth clients at launch.** Google is the one planned exception,
on the hosted tier only, once people are observed connecting Google through the guided path.

## Considered options

- **Keys only, OAuth later.** Rejected: it removes Gmail from the launch story, and Gmail is the
  first thing this audience connects.
- **First-party clients for the top vendors.** Executor.sh runs thirteen on its cloud, absent from
  self-host, each behind a fail-closed scope allowlist, with Google gated behind a rollout flag
  while its review runs. Rejected in general: this is the broker work Graft just chose not to
  rebuild, and every vendor is a verification programme that never ends.
- **A third-party broker for OAuth alone.** Rejected for now: a second subprocessor for the one
  auth shape, when the guided BYO path covers it.

## Consequences and accepted risks

- **Google's restricted scopes carry a real cost.** Reading Gmail through a server requires
  Google's app verification plus an annual third-party CASA assessment, commonly six to twelve
  weeks and thousands of dollars a year. That is why Google first-party is gated on demand and
  hosted-only.
- **A person's own Google project in Testing mode expires refresh tokens after seven days**, so a
  BYO Gmail tool re-consents weekly. The guide says so; it is the wart the Google exception exists
  to remove.
- **The console dance per vendor is friction.** Accepted: it is the honest version of "the agent
  does the research", and it keeps the credential model identical in both deployment forms.
- **No client secret ever passes through the agent.** Public PKCE clients may be registered by
  the agent; confidential ones only through the console handoff, following executor.sh's split.
