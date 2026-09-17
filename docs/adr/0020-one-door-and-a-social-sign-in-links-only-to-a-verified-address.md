---
status: accepted
---

# One door, and a social sign-in links to an existing account only through a verified address

Graft Cloud lets a person sign in with a Google or a GitHub account beside an email and a password
(GRA-81). Two decisions come with that, one about the screen and one about the accounts behind it.

## The console has one door

Cando's console has no sign-up screen: `/login` asks for the email, then the password beneath it in
the same card, tries to sign in, and registers the address when sign-in fails — Better Auth answers
"no such account" and "wrong password" identically on purpose, because telling them apart is
account enumeration, so the registration attempt is the only way to learn which it was (Cando's
CAN-64, and its `email-auth-outcome.ts`, copied here with its test). The provider buttons sit under
an *Or* rule in the same card. Graft's console is drawn with Cando's design system (ADR 0017), and
the door is where a person first meets it, from a handoff URL more often than from a bookmark
(ADR 0006); it is Cando's door, less what Graft does not have. `/signup` stays as a redirect so
every link written while there were two doors arrives at the one.

Two things Cando's door has are left out, each waiting on something rather than declined:
*Forgot password?* needs a mail transport, and nothing here sends mail yet
(`packages/auth/src/index.ts` says why verification is off); the invitation's locked address needs
an organisation, which is a column awaiting a UI (ADR 0007). The name a password sign-up gets is
the address's local part, as in Cando — which asks for the real one in onboarding before anything
shows it. Graft has no such step, so the account menu shows the placeholder until a settings row
exists; a provider sign-in carries the provider's name and needs none.

## Which providers, and the console asks

Google and GitHub, because those are the accounts the alpha's people — running Hermes, OpenClaw,
Claude — have. Each is an all-or-nothing group of its own in `@graft/env` (`GRAFT_GOOGLE_CLIENT_*`,
`GRAFT_GITHUB_CLIENT_*`), off by default, and registered with Better Auth by conditional spread,
because a provider key present is a provider advertised, credentials or not. Two groups rather than
one is Cando's reasoning for its Google and Apple pair: a deployment with one provider and not the
other is a normal state, and a single group would refuse to boot on it.

A self-host may configure neither, so the console does not hard-code the buttons: the server answers
`GET /api/sign-in-methods` with the providers it holds clients for, without a session, and the door
draws one button per name. A button the vendor would refuse at the first click is worse than no
button.

## Linking waits for a verified address on both sides

Someone opens an account with `alice@corp.com` and a password, then later clicks *Continue with
Google* on the same address. Cando's ADR 0007 links the two, trusting Google and Apple to have
verified the address, and argues that the refusal — "an account with this email already exists", to
someone who is that account holder — is a support ticket and a split identity.

Graft's account linking is Better Auth's default, and the default has a second condition Cando's
version did not: the *local* account's address must be verified too (`requireLocalEmailVerified`).
That condition is what stands between a squatted sign-up and a takeover. With email verification
off for the alpha, anyone can open a password account under any address without owning it; if a
social sign-in for that address then attached to it, the squatter would hold the real person's
account from the moment they signed in. So no provider is trusted blanket (`trustedProviders` is
unset); the provider's own per-address verified flag — Google's `email_verified`, GitHub's
`verified` on the address — decides the first condition, and the account's `emailVerified` the
second.

The consequence today: a password account does not link, whatever the provider says, because no
password account is verified yet. The person is returned to the door with a sentence saying the
address already has an account and to sign in the way it was opened
(`socialSignInMessage` in `apps/web/src/lib/sign-in.ts`). The reverse direction works: an account
opened through a provider has a verified address, and a second provider asserting the same verified
address links to it. When verification arrives with a mail transport, password accounts become
verified and Cando's outcome follows without a change here.

## Consequences

- The redirect URI a client is registered with is `GRAFT_AUTH_URL` plus
  `/api/auth/callback/google` or `/api/auth/callback/github`; on Graft Cloud,
  `https://app.getgraft.ai/api/auth/callback/<provider>`. A client copied from another product's
  console needs that URI added before its button works.
- The hosted tier holds the client secrets in Secrets Manager and the client ids as stack config
  gating each group, the Pipedream group's shape (graft-cloud's secrets and app stacks).
- A provider is added by adding its group to `@graft/env`, its name to `SOCIAL_PROVIDER_NAMES` in
  `@graft/auth`, its label and mark to the console — and, before it is trusted for anything more
  than the flag it asserts, confirming how it verifies an address.
