# Security

## Reporting a vulnerability

Email **aleks@getmodern.ai**. That is the route: GitHub's private vulnerability reporting is not
enabled on this repository, and a public issue is the one place a vulnerability should not go. Say
what you found, how to reach it and what it lets someone do; a proof of concept against your own
self-hosted deployment helps, and please do not test against Graft Cloud. What we intend, rather
than promise: an acknowledgement within three working days and, for anything we confirm, a fix or
a written plan within fourteen. If a report is something we will not change, we will say so and
why. There is no bounty at this time.

## Scope

Graft lets an agent reach a vendor without holding a credential, and keeps the person in the loop
where a decision is theirs. Anything that breaks either is in scope:

- The **proxy** and its host pinning: a vendor request that leaves for a host the connection does
  not name, a redirect or a private address followed, a credential echoed back.
- The **capability token**: one accepted for a connection, tool or dry run it does not name, or
  minted for an agent outside its scope.
- The **vault**: a stored credential that becomes readable, or a decrypt outside the proxy binding
  and the OAuth callback. The **sandbox**: egress that is not the proxy, or escape.
- The **approval and ask flows**: an approval or a connection confirmation that something other
  than the person can answer, or a handoff URL that works for someone it was not signed for.
- The **MCP OAuth server**: a token issued to the wrong client or agent, a code or refresh token
  replayed, a consent decided without a session. The **console**: a cross-origin state change.

Out of scope: a vendor's own API, a self-hosted deployment's own misconfiguration (an exposed
database, a public console with no reverse proxy, a leaked `.env`), and the quality of what the
model writes, which the check, the dry run and the approvals exist to bound.

## Where the design is written down

`docs/adr/`: 0004 (who holds the pen), 0006 (the console is the channel to the human), 0008 (reads
pass, writes ask once), 0010 (an SDK reaches a vendor through the proxy or not at all), 0013
(packages install at publish or never), 0018 (MCP clients authenticate with OAuth). README
summarises them under "How it is safe". **No third-party audit has been done**: the design is
ours, reviewed by us.
