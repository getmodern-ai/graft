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

  const res = await ctx.fetch(`/charges?${params.toString()}`, { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/charges ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as ChargeList;
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
  };
};
