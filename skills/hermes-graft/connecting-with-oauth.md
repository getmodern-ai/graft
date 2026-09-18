# Connecting a vendor that needs an OAuth consent

Gmail, Slack user tokens, Notion and most Google APIs do not hand out API keys: the person signs
in at the vendor and consents, and the vendor issues tokens to a **client** somebody registered.
Graft runs that flow against a client **the person registers themselves** — Graft operates no
client of its own for these vendors — and you are the guide: you read the vendor's OAuth
documentation, propose the endpoints and scopes, and tell the person exactly what to create and
where to paste the one value only Graft knows. The client secret and the tokens never pass
through you; the person enters the secret in the console and the consent runs in a popup there.

## The proposal

Call `request_connection` with `scheme: "oauth_authorization_code"` and, in `schemeConfig`, the
`authorizeUrl` and `tokenUrl` from the vendor's OAuth documentation and the `scopes` the task
needs, space-separated and as narrow as the task allows. Leave `clientId` out: you cannot know it,
and the form asks the person for it. Name the documentation page you read as `docsUrl`.
`primaryHost` and `hosts` are the hosts tool calls will reach, `gmail.googleapis.com` for Gmail,
never the sign-in endpoints: those live in `schemeConfig`, and one listed under `hosts` is set
aside and named in the answer.

The answer is `awaiting_connection` with a handoff `url` and a `redirectUri`. Relay both.

## Guiding the registration

Say three things, one sentence each, before the link:

1. **Where to create the client.** The vendor's developer console — for Google, *Google Cloud
   Console → APIs & Services → Credentials → Create credentials → OAuth client ID*, of type *Web
   application*; enable the API the scopes belong to (Gmail API for Gmail) under *Library* first.
2. **What to name it.** Something with "Graft" in it, so they recognise it in the vendor's list a
   year from now — *Graft (my laptop agent)*.
3. **Which redirect URI to paste.** The `redirectUri` from the answer, exactly, into the client's
   *Authorized redirect URIs*. It is the one URI Graft's server answers on for every vendor; a
   character off and the vendor refuses the consent with `redirect_uri_mismatch`.

Then relay the handoff `url`: the form there is pre-filled with your proposal, asks for the
client id and secret the vendor just showed them, shows the same redirect URI beside the inputs,
and its Connect button runs the consent in a popup. When the popup says connected, call
`request_connection` again with the same proposal; it answers `connected` and the connection's
`execute__<id>` tool is in your list.

## Google, the worked example

- A Google Cloud project starts in **Testing mode**. Add the person's own Google account under
  *OAuth consent screen → Test users*, or the consent page refuses them.
- In Testing mode, Google **expires refresh tokens after seven days**. The connection will ask to be
  reconnected weekly — the console shows *Reconnect* on it — until the project is published, and
  publishing an app that reads Gmail needs Google's verification and a CASA assessment. Say so once
  when you guide them; the form says it too.
- Gmail's read scope is `https://www.googleapis.com/auth/gmail.readonly`; reading subject lines
  needs nothing wider. The API host is `gmail.googleapis.com`; the endpoints are
  `https://accounts.google.com/o/oauth2/v2/auth` and `https://oauth2.googleapis.com/token`.

## When a call fails later

A vendor `401` on an OAuth connection usually means the refresh token died — the seven-day expiry
above, or the person revoked the app at the vendor. Graft has already tried to refresh once and
passed you the vendor's own `401`. Call `request_credential` with the connection id and what the
vendor said: for an OAuth connection the person is asked to **reconnect** — one click, the consent
again — not to type anything, unless the connection was revoked in the console, in which case they
enter the client secret first.
