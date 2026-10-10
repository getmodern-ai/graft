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

  const res = await ctx.fetch(`/invoices?${params.toString()}`);
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

  return { invoices, hasMore: result.has_more ?? false };
};
