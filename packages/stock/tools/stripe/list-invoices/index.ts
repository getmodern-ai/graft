// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type StripeInvoice = {
  id: string;
  number?: string | null;
  customer?: string | { id?: string } | null;
  customer_email?: string | null;
  customer_name?: string | null;
  status?: string | null;
  currency?: string | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  amount_remaining?: number | null;
  total?: number | null;
  created?: number | null;
  due_date?: number | null;
  hosted_invoice_url?: string | null;
};

type StripeInvoiceList = {
  data?: StripeInvoice[];
  has_more?: boolean;
};

const toIso = (timestamp: number | null | undefined): string | null =>
  typeof timestamp === "number" ? new Date(timestamp * 1000).toISOString() : null;

export default async (input: Input, ctx: Context) => {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 10));
  if (input.customer !== undefined) params.set("customer", input.customer);
  if (input.status !== undefined) params.set("status", input.status);
  if (input.cursor !== undefined) params.set("starting_after", input.cursor);

  const res = await ctx.fetch(`/invoices?${params.toString()}`, {
    headers: { "stripe-version": STRIPE_VERSION },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/invoices ${res.status}: ${await res.text()}`);
  }

  const result = (await res.json()) as StripeInvoiceList;
  const invoices = (result.data ?? []).map((invoice) => ({
    id: invoice.id,
    number: invoice.number ?? null,
    customer:
      typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null),
    customer_email: invoice.customer_email ?? null,
    customer_name: invoice.customer_name ?? null,
    status: invoice.status ?? null,
    currency: invoice.currency ?? null,
    amount_due: invoice.amount_due ?? null,
    amount_paid: invoice.amount_paid ?? null,
    amount_remaining: invoice.amount_remaining ?? null,
    total: invoice.total ?? null,
    created: toIso(invoice.created),
    due_date: toIso(invoice.due_date),
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
  }));

  const hasMore = result.has_more ?? false;
  const last = invoices[invoices.length - 1];
  return { invoices, hasMore, nextCursor: hasMore ? (last?.id ?? null) : null };
};
