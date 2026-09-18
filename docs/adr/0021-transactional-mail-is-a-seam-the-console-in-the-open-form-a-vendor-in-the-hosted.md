---
status: accepted
---

# Transactional mail is a seam: the console transport in the open form, a vendor's in the hosted

Graft sends one transactional email today — the password reset (GRA-82) — and mail is the fifth
seam of ADR 0002, beside the sandbox, the keyring, the toolbox store and the connection providers:
the open core defines the seam and ships the open form's backing, and the hosted form's backing
lives only in the private package, hidden by absence.

**Amended 2026-09-18 (GRA-90).** As first written for GRA-82 this decision was "transactional mail
goes through Loops, with the console transport as the floor", and the Loops transport, the id of a
template in Graft Cloud's Loops workspace, and `GRAFT_LOOPS_API_KEY` were all in the open
repository — a copy of Cando's `@cando/email` (ADR 0011) made without applying ADR 0002 to it.
Cando is one closed product and a vendor in its core costs nothing; Graft's core is about to be
public, and a self-hoster reading a vendor's template id in it has code that cannot work for them.
This is the corrected decision.

## The seam

`@graft/email` owns three things and names no vendor: the **transport** type — `send(request)`
answering one `SendResult` shape, `{ delivered, transport }`, which every backing must honour (a
predecessor codebase had its dev path return `undefined` and every local send recorded as failed);
the **registry**, the one place an email's name, its data-variables schema and its subject are
declared; and the **façade**, one typed send function per email, which validates against the
registry and hands the transport a named template with its variables and its action link. A
transport that renders through a vendor's hosted templates maps the name to an id of its own; one
that renders itself has the subject and the variables. The registry is what every caller is held to,
so a variable renamed under a hosted template fails at the seam, not as a blank in an inbox.

## The open form's backing is the console transport

Unset, in every form, the console transport prints the envelope, the variables and the action URL
on a line of its own — a reset is read out of `docker compose logs graft`. That is the whole mail
stack on a laptop and in the self-hosted image, and it is deliberately not nothing: a self-hoster
who has just installed Graft has no mail provider on day one, and the link in the log is a
legitimate way to reset a password for an operator who can read the log. An SMTP backing for the
open form is the natural next step and its own ticket; until it exists, the console is the floor.

## The hosted form's backing is a vendor's, in the private package

Graft Cloud sends through Loops — Cando's choice and Cando's reasoning (its ADR 0013): Loops'
transactional API deletes the SES plan's two expensive parts, the infrastructure and the in-repo
template layer, and marketing mail is heading there anyway. The transport, the map from the
registry's template names to Loops' transactional ids, and `GRAFT_LOOPS_API_KEY` in the private
environment schema are `@graft/cloud-backings`' and appear nowhere in this repository. The private
factory answers `mail` beside the other seams; the selector takes it under `GRAFT_BACKINGS=cloud`
and keeps the console transport when the factory answers none, so a hosted deploy without a mail
key still boots and still logs the link. If Loops ever has to go, the swap is one transport in one
package.

## What stays the same either side

- **One template, no sanitizer.** The reset email carries a URL built from the configured console
  origin and Better Auth's token; nothing a person typed reaches it. Cando's display-name sanitizer
  existed for the invitation's names, and Graft has no organisation (ADR 0007). When Graft sends an
  email whose variables a person controls, copy the sanitizer with it.
- **The link is the console's.** `GRAFT_CONSOLE_URL` plus `/reset-password?token=…` — the
  console's origin, as every handoff URL is (ADR 0006) — not Better Auth's own callback under
  `GRAFT_AUTH_URL`, which in development is a different port and which the console route does not
  need: `resetPassword` consumes the raw token.
- **A send never fails the operation that asked for it.** A transport answers `delivered: false`
  and logs; the reset hook catches and logs with the person's id, never the address, so
  `requestPasswordReset` answers identically for known and unknown addresses.
- Email verification at sign-up now has its transport; turning it on is a decision recorded on the
  option in `packages/auth/src/index.ts`, and the consequence for account linking is ADR 0020's.
