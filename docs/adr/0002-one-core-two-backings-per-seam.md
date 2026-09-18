---
status: accepted
---

# One core, two backings per seam

Graft is one agnostic core with **exactly two implementations behind each seam**: the sandbox, the
keyring, the toolbox storage, and later the model provider. The self-hosted form runs the core in
Docker with a Docker sandbox, a local keyring and a filesystem toolbox. The hosted form runs the
same core with Blaxel sandboxes, a KMS-backed keyring and S3. **The hosted product ships first**,
because it is the form that produces revenue and the authoring traces ADR 0012 needs; the Docker
image ships beside it because it is also the development environment and the bet's audience
self-hosts.

The commercial parts are hidden **by absence, not by flag**. The open repository contains the core
and the self-hosted backings. The hosted backings, multi-tenant billing and the curated package
mirror live in a private package that implements the same interfaces. There are no runtime flags
in the open code that switch commercial behaviour on.

## Considered options

- **Local-first plugin inside the harness, no server.** Rejected: it makes Graft a component of
  two vendors' release schedules, and it offers no place for the hosted authoring model.
- **Hosted only.** Rejected: the audience chose OpenClaw or Hermes partly to keep credentials on
  their own hardware, and the Docker form is nearly free once the seams exist.
- **A general plugin system so third parties can add backings.** Rejected on executor.sh's own
  evidence: its plugin registry, some 850 lines of optional hooks, never gained a fourth
  implementation and its authors call it "a fiction" they are removing. Two implementations per
  interface is the honest shape.
- **Feature flags in one codebase.** Rejected: flags advertise the shape of what is hidden and rot
  the same way a fake-open registry does.

## Consequences and accepted risks

- **Every seam is a plain interface with two tests**, and a change to the interface lands in both
  backings in the same PR.
- **The Docker form needs the Docker socket or a sibling-container pattern** to launch sandboxes.
  This is an operational surface executor.sh avoided by running model code in an in-process
  QuickJS interpreter; Graft cannot, because authored tools need a filesystem and a route to the
  proxy (ADR 0013).
- **The private package is a second repository to keep in step.** Accepted as the cost of an open
  core that is actually open.

## Amendment 2026-09-19: no vendor in the open repository — a seam here, the vendor's backing there

**Decided by Aleks on 2026-09-19, while GRA-100 was in review.** As written, this decision hid the
*commercial* parts by absence and said nothing about a vendor a self-hoster could plausibly use
with their own account. Two things then landed in the open repository as "open code switched on by
configuration": the Pipedream connection provider (ADR 0019, GRA-59) and, with GRA-31, a Langfuse
client for model tracing; GRA-100 was about to add an Axiom drain and a PostHog client the same
way. Aleks's rule is the stricter one, and it is the rule from here:

**The open repository carries no vendor's client library, no vendor's configuration variable and
none of a vendor's ids.** What it carries is the seam — a plain interface, the open form's backing
where the open form has one, and a no-op where it has none — and the hosted form's vendor rides the
private package, answered from `createCloudBackings` beside the sandbox, the keyring, the mirror and
mail. The test is no longer "could a self-hoster use this with their own account?" but "is this a
vendor?"; a self-hoster who wants that vendor writes the backing against the seam, which is what a
seam is for.

Three seams are added under this rule, each with **no backing in the open form**:

- **The log drain** (`@graft/observability`'s `LogDrain`): where a wide event goes after stdout.
  The open form's events stay on stdout, which is the container's log; the hosted form's Axiom
  drain is the private package's, and the server hands its `drain` to `initLogger`.
- **Analytics** (`Analytics`, with the event vocabulary in `events.ts` and `NO_ANALYTICS`): what
  the server counts product events through. The open form counts nothing. The events are captured
  server-side at two chokepoints — the JSON API's mutation routes for the console's actions, the
  MCP tool-call hook and the acquire runner for what happens over MCP — and **the console carries no
  analytics library**: pageviews and sessions are given up rather than ship a browser vendor in the
  open console, which one image builds for both forms.
- **Model telemetry** (`@graft/model`'s `ModelTelemetry`, the backing as `ModelTelemetryBacking`):
  the integrations a model call names and the wrapper that carries the trace's attributes. The open
  form runs under `NO_TELEMETRY`; the Langfuse binding GRA-31 wrote moves to the private package.

`Backings` in `apps/server/src/backings.ts` carries the three (`logDrain`, `analytics`,
`modelTelemetry`), the selector fills them from the private package under `cloud` and leaves them
empty under `open`, and the boot line names each. The variables that configure them
(`GRAFT_AXIOM_*`, `GRAFT_POSTHOG_*`, `GRAFT_LANGFUSE_*`) are the private package's schema's, not
`@graft/env`'s.

**Consequences.** A self-host phones nowhere by construction, not by leaving a variable unset. The
one open exception that remains is the Pipedream provider, recorded as an oversight and scheduled to
move behind `Backings.providers` under [GRA-103](https://linear.app/get-modern/issue/GRA-103); the
gateway provider (GRA-58) stays, because a company's own API gateway is not a vendor of Graft's. The
mail seam's SMTP backing (ADR 0021 as amended for GRA-92) stays too: a relay is a protocol, not a
vendor. The private package grows a dependency for each vendor it backs, which is where those
dependencies belong.
