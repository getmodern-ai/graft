---
status: accepted
---

# Transactional mail goes through Loops, with the console transport as the floor

Graft sends one transactional email today — the password reset (GRA-82) — and it goes through
Cando's arrangement, copied (ADR 0011): `@graft/email` is `@cando/email` less the member
invitation, and the reasoning is Cando's ADR 0013. Loops rather than SES, because Loops' transactional
API deletes the two most expensive parts of the SES plan — the infrastructure (identity, DKIM,
MAIL FROM, task-role IAM, the sandbox-to-production support case) and the in-repo template layer —
and marketing mail is heading to Loops in any case. What Loops leaves standing is everything
product-shaped: the façade, the transport seam, the Better Auth hook, the two console screens. If
Loops ever has to go, the swap is one transport and re-authoring the templates, not a product rework.

## What is different here

**The console transport is the floor, not only the laptop's.** Cando's console transport exists so
a laptop needs no mail setup: unset key, the send prints the envelope and the action link to the
server's log. Graft's self-hosted form (ADR 0002) has the same need and no operator to open a Loops
account on day one, and the hosted form has no Loops account yet either. So the console transport is
the default in every form, and a reset on a deployment without a key is read out of the server's
log — for the hosted form, the `/ecs/graft-server` log group. That is a legitimate way to reset a
password for an alpha whose operator can read the log, and a poor one for a customer, which is what
`GRAFT_LOOPS_API_KEY` is for.

**One template, no sanitizer.** The reset email carries a URL built from the configured console
origin and Better Auth's token; nothing a person typed reaches the template. Cando's display-name
sanitizer existed for the invitation's inviter and organisation names, and Graft has no organisation
(ADR 0007), so neither the invitation nor the sanitizer is copied. When Graft sends a second email
whose variables a person controls, copy the sanitizer with it.

**The link is the console's.** The reset URL is `GRAFT_CONSOLE_URL` plus `/reset-password?token=…`
— the console's origin, as every handoff URL is (ADR 0006) — not Better Auth's own callback under
`GRAFT_AUTH_URL`, which in development is a different port and which the console route does not
need: `resetPassword` consumes the raw token.

## Consequences

- The environment switch is one optional secret, `GRAFT_LOOPS_API_KEY`: set, Loops; unset, the
  console transport. One key cannot be half-set, so it joins the schema without the all-or-nothing
  machinery — but it is secret-backed, so it takes the placeholder rule and, on the hosted tier,
  the full Secrets Manager path (an entry, a gate, the execution role's read grant).
- Templates live in the Loops dashboard, not in git. `packages/email/src/registry.ts` is the one
  place a template's transactional id and its variables are named. The reset template was published
  in Graft's Loops workspace on 2026-09-18 (GRA-82) and its id recorded there; a template edited out
  from under the code fails as a logged 400 on the first send, not a boot failure.
- A send never fails the operation that asked for it. The transport answers `delivered: false` and
  logs; the reset hook catches and logs with the person's id, never the address, so
  `requestPasswordReset` answers identically for known and unknown addresses.
- Email verification at sign-up now has its transport; turning it on is a decision recorded on the
  option in `packages/auth/src/index.ts`, and the consequence for account linking is ADR 0020's.
