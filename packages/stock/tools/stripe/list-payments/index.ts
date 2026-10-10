// Every path is from api.stripe.com's root, so a connection whose base URL lacks `/v1` still
// reaches the same endpoints (GRA-261; ADR 0010 as amended 2026-09-24, `ctx.fetch`'s `host`).
const STRIPE_HOST = "api.stripe.com";
// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type Charge = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  paid: boolean;
  refunded: boolean;
  amount_refunded: number;
  created: number;
  description: string | null;
  customer: string | null;
  payment_intent: string | null;
  receipt_email: string | null;
};

type ChargeList = {
  data: Charge[];
  has_more: boolean;
};

export default async (input: Input, ctx: Context) => {
  const params = new URLSearchParams({ limit: String(input.limit ?? 10) });
  if (input.customer) params.set("customer", input.customer);
  if (input.cursor !== undefined) params.set("starting_after", input.cursor);

  const res = await ctx.fetch(`/v1/charges?${params.toString()}`, {
    host: STRIPE_HOST,
    method: "GET",
    headers: { "stripe-version": STRIPE_VERSION },
  });
  if (!res.ok) throw new Error(`GET /v1/charges ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as ChargeList;
  const last = body.data[body.data.length - 1];
  return {
    payments: body.data.map((charge) => ({
      id: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      status: charge.status,
      paid: charge.paid,
      refunded: charge.refunded,
      amount_refunded: charge.amount_refunded,
      created: new Date(charge.created * 1000).toISOString(),
      description: charge.description,
      customer: charge.customer,
      payment_intent: charge.payment_intent,
      receipt_email: charge.receipt_email,
    })),
    hasMore: body.has_more,
    nextCursor: body.has_more ? (last?.id ?? null) : null,
  };
};
