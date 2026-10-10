// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_HEADERS = { "stripe-version": "2026-02-25.clover" };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nullable = (value: unknown): unknown => (value === undefined ? null : value);

const isoTime = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

const objectId = (value: unknown): unknown =>
  isObject(value) ? nullable(value.id) : nullable(value);

// The pinned version itemises tax as `total_taxes`; `tax` is the single figure older versions gave.
const taxOf = (invoice: JsonObject): unknown => {
  if (Array.isArray(invoice.total_taxes)) {
    return invoice.total_taxes
      .filter(isObject)
      .reduce((sum, entry) => sum + (typeof entry.amount === "number" ? entry.amount : 0), 0);
  }
  return nullable(invoice.tax);
};

export default async (input: Input, ctx: Context) => {
  let invoiceId = input.invoice;

  if (!invoiceId) {
    const listResponse = await ctx.fetch("/invoices?limit=1", { headers: STRIPE_HEADERS });
    if (listResponse.status === 404) return { found: false };
    if (!listResponse.ok) {
      throw new Error(`GET /v1/invoices ${listResponse.status}: ${await listResponse.text()}`);
    }

    const list: unknown = await listResponse.json();
    const data = isObject(list) && Array.isArray(list.data) ? list.data : [];
    const first = data[0];
    if (!isObject(first) || typeof first.id !== "string") return { found: false };
    invoiceId = first.id;
  }

  const response = await ctx.fetch(`/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: STRIPE_HEADERS,
  });
  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new Error(`GET /v1/invoices/${invoiceId} ${response.status}: ${await response.text()}`);
  }

  const value: unknown = await response.json();
  if (!isObject(value))
    throw new Error(`GET /v1/invoices/${invoiceId} returned an invalid response`);

  const linesObject = isObject(value.lines) ? value.lines : {};
  const lineData = Array.isArray(linesObject.data) ? linesObject.data : [];
  const lines = lineData.filter(isObject).map((line) => {
    const price = isObject(line.price) ? line.price : null;
    const pricing = isObject(line.pricing) ? line.pricing : null;
    const priceDetails = pricing && isObject(pricing.price_details) ? pricing.price_details : null;
    const priceId =
      price && typeof price.id === "string"
        ? price.id
        : priceDetails && typeof priceDetails.price === "string"
          ? priceDetails.price
          : null;

    return {
      id: nullable(line.id),
      description: nullable(line.description),
      amount: nullable(line.amount),
      currency: nullable(line.currency),
      quantity: nullable(line.quantity),
      price: priceId,
    };
  });

  return {
    found: true,
    id: nullable(value.id),
    number: nullable(value.number),
    customer: objectId(value.customer),
    customer_email: nullable(value.customer_email),
    customer_name: nullable(value.customer_name),
    status: nullable(value.status),
    collection_method: nullable(value.collection_method),
    currency: nullable(value.currency),
    subtotal: nullable(value.subtotal),
    tax: taxOf(value),
    total: nullable(value.total),
    amount_due: nullable(value.amount_due),
    amount_paid: nullable(value.amount_paid),
    amount_remaining: nullable(value.amount_remaining),
    created: isoTime(value.created),
    due_date: isoTime(value.due_date),
    period_start: isoTime(value.period_start),
    period_end: isoTime(value.period_end),
    hosted_invoice_url: nullable(value.hosted_invoice_url),
    invoice_pdf: nullable(value.invoice_pdf),
    lines,
    linesHasMore: linesObject.has_more === true,
  };
};
