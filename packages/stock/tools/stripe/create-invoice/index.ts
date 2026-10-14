// Every path is from api.stripe.com's root, so a connection whose base URL lacks `/v1` still
// reaches the same endpoints (GRA-261; ADR 0010 as amended 2026-09-24, `ctx.fetch`'s `host`).
const STRIPE_HOST = "api.stripe.com";
// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type StripeInvoice = {
  id?: unknown;
  number?: unknown;
  status?: unknown;
  total?: unknown;
  currency?: unknown;
  amount_due?: unknown;
  hosted_invoice_url?: unknown;
};

type PostResult = {
  intercepted: boolean;
  data: StripeInvoice | null;
};

type Item = Input["items"][number];

const plainForm = (form: URLSearchParams): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of form.entries()) result[key] = value;
  return result;
};

const postForm = async (ctx: Context, path: string, form: URLSearchParams): Promise<PostResult> => {
  const res = await ctx.fetch(`/v1${path}`, {
    host: STRIPE_HOST,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_VERSION,
    },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`POST /v1${path} ${res.status}: ${await res.text()}`);
  }

  const intercepted = res.headers.get("x-graft-dry-run") === "intercepted";
  if (intercepted) return { intercepted: true, data: null };
  return { intercepted: false, data: (await res.json()) as StripeInvoice };
};

const getInvoice = async (ctx: Context, invoiceId: string): Promise<StripeInvoice> => {
  const res = await ctx.fetch(`/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    host: STRIPE_HOST,
    headers: { "stripe-version": STRIPE_VERSION },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/invoices/${invoiceId} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as StripeInvoice;
};

// Every item is judged before the first write, so an input naming a bad one creates nothing.
const itemProblem = (item: Item): string | null => {
  const hasPrice = typeof item.price === "string";
  const hasInlineFields =
    item.amount !== undefined || item.currency !== undefined || item.description !== undefined;
  if (hasPrice && hasInlineFields) {
    return "must use either price or amount, currency, and description, not both";
  }
  if (
    !hasPrice &&
    (item.amount === undefined ||
      typeof item.currency !== "string" ||
      typeof item.description !== "string")
  ) {
    return "must provide either price or amount, currency, and description";
  }
  return null;
};

export default async (input: Input, ctx: Context) => {
  const problems = input.items.flatMap((item, index) => {
    const problem = itemProblem(item);
    return problem === null ? [] : [`Item ${index + 1} ${problem}.`];
  });
  if (problems.length > 0) {
    throw new Error(`Nothing was created. ${problems.join(" ")}`);
  }

  const invoiceForm = new URLSearchParams();
  invoiceForm.set("customer", input.customer);
  invoiceForm.set("collection_method", "send_invoice");
  invoiceForm.set("days_until_due", String(input.daysUntilDue ?? 30));
  invoiceForm.set("pending_invoice_items_behavior", "exclude");
  if (input.description !== undefined) invoiceForm.set("description", input.description);

  const created = await postForm(ctx, "/invoices", invoiceForm);
  const dryRun = created.intercepted;
  const createdId = created.data?.id;
  if (!dryRun && typeof createdId !== "string") {
    throw new Error("POST /v1/invoices returned no invoice id");
  }
  const invoiceId = dryRun ? "(new invoice id)" : (createdId as string);

  const itemForms: Array<Record<string, string>> = [];
  for (const [index, item] of input.items.entries()) {
    const itemForm = new URLSearchParams();
    itemForm.set("customer", input.customer);
    itemForm.set("invoice", invoiceId);
    if (typeof item.price === "string") {
      itemForm.set("pricing[price]", item.price);
    } else {
      itemForm.set("amount", String(item.amount));
      itemForm.set("currency", item.currency as string);
      itemForm.set("description", item.description as string);
    }
    if (item.quantity !== undefined) itemForm.set("quantity", String(item.quantity));
    itemForms.push(plainForm(itemForm));
    try {
      await postForm(ctx, "/invoiceitems", itemForm);
    } catch (error) {
      if (dryRun) throw error;
      // The draft exists by now: naming it keeps a retry from leaving a second one beside it.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Draft invoice ${invoiceId} was created, but Stripe refused item ${index + 1}, so the draft holds only the items before it: ${message}`,
      );
    }
  }

  let sendForm: Record<string, string> | null = null;
  let sentInvoice: StripeInvoice | null = null;
  if (input.send ?? false) {
    const form = new URLSearchParams();
    sendForm = plainForm(form);
    const sent = await postForm(ctx, `/invoices/${encodeURIComponent(invoiceId)}/send`, form);
    if (!sent.intercepted) sentInvoice = sent.data;
  }

  if (dryRun) {
    return {
      created: false,
      sent: {
        invoice: plainForm(invoiceForm),
        items: itemForms,
        send: sendForm,
      },
    };
  }

  // The invoice answered at creation was empty: its amounts are read once the items are on it.
  const finalInvoice = sentInvoice ?? (await getInvoice(ctx, invoiceId));
  return {
    id: invoiceId,
    number: finalInvoice.number ?? null,
    status: finalInvoice.status ?? null,
    total: finalInvoice.total ?? null,
    currency: finalInvoice.currency ?? null,
    amount_due: finalInvoice.amount_due ?? null,
    hosted_invoice_url: finalInvoice.hosted_invoice_url ?? null,
    sent: input.send ?? false,
  };
};
