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

const plainForm = (form: URLSearchParams): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of form.entries()) result[key] = value;
  return result;
};

const postForm = async (ctx: Context, path: string, form: URLSearchParams): Promise<PostResult> => {
  const res = await ctx.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`POST /v1${path} ${res.status}: ${await res.text()}`);
  }

  const intercepted = res.headers.get("x-graft-dry-run") === "intercepted";
  if (intercepted) return { intercepted: true, data: null };
  return { intercepted: false, data: (await res.json()) as StripeInvoice };
};

export default async (input: Input, ctx: Context) => {
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
  for (const item of input.items) {
    const hasPrice = typeof item.price === "string";
    const hasInlineFields =
      item.amount !== undefined || item.currency !== undefined || item.description !== undefined;
    if (hasPrice && hasInlineFields) {
      throw new Error(
        "Each item must use either price or amount, currency, and description, not both",
      );
    }
    if (
      !hasPrice &&
      (item.amount === undefined ||
        typeof item.currency !== "string" ||
        typeof item.description !== "string")
    ) {
      throw new Error("Each item must provide either price or amount, currency, and description");
    }

    const itemForm = new URLSearchParams();
    itemForm.set("customer", input.customer);
    itemForm.set("invoice", invoiceId);
    if (hasPrice) {
      itemForm.set("pricing[price]", item.price as string);
    } else {
      itemForm.set("amount", String(item.amount));
      itemForm.set("currency", item.currency as string);
      itemForm.set("description", item.description as string);
    }
    if (item.quantity !== undefined) itemForm.set("quantity", String(item.quantity));
    itemForms.push(plainForm(itemForm));
    await postForm(ctx, "/invoiceitems", itemForm);
  }

  let finalInvoice = created.data;
  let sendForm: Record<string, string> | null = null;
  if (input.send ?? false) {
    const form = new URLSearchParams();
    sendForm = plainForm(form);
    const sent = await postForm(ctx, `/invoices/${invoiceId}/send`, form);
    if (!sent.intercepted) finalInvoice = sent.data;
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

  if (!finalInvoice) throw new Error("Stripe returned no invoice");
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
