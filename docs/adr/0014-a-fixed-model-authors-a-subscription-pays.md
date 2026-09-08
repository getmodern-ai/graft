---
status: accepted, provisional
---

# A fixed model authors, a subscription pays

In the hosted form, `acquire` runs on **one strong coding model Graft chooses**, with a cheap model
for triage and search, both on Graft's account. A person may **bring their own model key** on the
hosted tier to lower the price. **The self-hosted form always requires a bring-your-own key** and a
provider setting, and refuses to start without one, as Cando's worker does.

The unit of price is **a successful acquisition**: a published tool whose dry run passed. Failed
attempts cost the person nothing and are capped internally by attempt count and a token ceiling.
**Runs through the proxy are not metered.** The offer is a **subscription with an acquisition
allowance**: a free tier with a few acquisitions a month and a small working-set cap, a paid tier
with more of both, overage per acquisition. Repairs (ADR 0012, L2) count as acquisitions when they
ship. Cando's Stripe plumbing under its ADR 0030 carries over almost unchanged.

**This decision is provisional.** It is the shape to launch with; the unit and the tiers are
revisited once there are acquisitions to count.

## Considered options

- **Token passthrough with margin**, Cando's credit model. Rejected: it prices the thing the
  person cannot control, how many attempts the model needed.
- **Metering runs.** Rejected: it would punish exactly the behaviour Graft wants, a tool used
  often.
- **The customer's model only, everywhere.** Rejected as the default: a strong coding model
  writing the integration is the concrete reason a person running a cheap model pays.

## Consequences and accepted risks

- **Graft bears the risk of a flaky vendor or a weak attempt.** That is where it belongs if the
  pitch is that the loop just works.
- **A BYO-key hosted user routes their vendor documentation through their own provider**, which
  simplifies the disclosure in ADR 0004.
- **Revisit when** the first hundred acquisitions have been counted, or when the L2 repair cost
  turns out not to fit the acquisition unit.
