// Every path is from api.stripe.com's root, so a connection whose base URL lacks `/v1` still
// reaches the same endpoints (GRA-261; ADR 0010 as amended 2026-09-24, `ctx.fetch`'s `host`).
const STRIPE_HOST = "api.stripe.com";
// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type RefundResponse = {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
  charge: string | null;
  payment_intent: string | null;
  reason: string | null;
  created: number;
};

export default async (input: Input, ctx: Context) => {
  const hasCharge = input.charge !== undefined;
  const hasPaymentIntent = input.paymentIntent !== undefined;

  if (hasCharge === hasPaymentIntent) {
    throw new Error("Provide exactly one of charge or paymentIntent.");
  }

  const form = new URLSearchParams();
  if (input.charge !== undefined) form.set("charge", input.charge);
  if (input.paymentIntent !== undefined) form.set("payment_intent", input.paymentIntent);
  if (input.amount !== undefined) form.set("amount", String(input.amount));
  if (input.reason !== undefined) form.set("reason", input.reason);
  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      form.set(`metadata[${key}]`, value);
    }
  }

  const sent = Object.fromEntries(form.entries());
  const res = await ctx.fetch("/v1/refunds", {
    host: STRIPE_HOST,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_VERSION,
    },
    body: form,
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent };
  }

  if (!res.ok) {
    throw new Error(`POST /v1/refunds ${res.status}: ${await res.text()}`);
  }

  const refund = (await res.json()) as RefundResponse;
  return {
    id: refund.id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
    charge: refund.charge,
    payment_intent: refund.payment_intent,
    reason: refund.reason,
    created: new Date(refund.created * 1000).toISOString(),
  };
};
