// Every path is from api.stripe.com's root, so a connection whose base URL lacks `/v1` still
// reaches the same endpoints (GRA-261; ADR 0010 as amended 2026-09-24, `ctx.fetch`'s `host`).
const STRIPE_HOST = "api.stripe.com";
// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record.id === "string" ? record.id : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

export default async (input: Input, ctx: Context) => {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit ?? 10));
  query.set("status", input.status ?? "all");
  if (input.customer !== undefined) query.set("customer", input.customer);
  if (input.cursor !== undefined) query.set("starting_after", input.cursor);

  const res = await ctx.fetch(`/v1/subscriptions?${query.toString()}`, {
    host: STRIPE_HOST,
    headers: { "stripe-version": STRIPE_VERSION },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/subscriptions ${res.status}: ${await res.text()}`);
  }

  const body = asRecord(await res.json());
  const data = Array.isArray(body.data) ? body.data : [];

  const subscriptions = data.map((value) => {
    const subscription = asRecord(value);
    const itemList = asRecord(subscription.items);
    const rawItems = Array.isArray(itemList.data) ? itemList.data : [];
    const firstItem = rawItems.length > 0 ? asRecord(rawItems[0]) : {};
    const periodStart = subscription.current_period_start ?? firstItem.current_period_start;
    const periodEnd = subscription.current_period_end ?? firstItem.current_period_end;

    const items = rawItems.map((rawItem) => {
      const item = asRecord(rawItem);
      const price = asRecord(item.price);
      const recurring = asRecord(price.recurring);
      return {
        price_id: idOf(price),
        product_id: idOf(price.product),
        unit_amount: typeof price.unit_amount === "number" ? price.unit_amount : null,
        recurring_interval: typeof recurring.interval === "string" ? recurring.interval : null,
        quantity: typeof item.quantity === "number" ? item.quantity : null,
      };
    });

    return {
      id: typeof subscription.id === "string" ? subscription.id : null,
      customer: idOf(subscription.customer),
      status: typeof subscription.status === "string" ? subscription.status : null,
      created: isoTimestamp(subscription.created),
      current_period_start: isoTimestamp(periodStart),
      current_period_end: isoTimestamp(periodEnd),
      cancel_at: isoTimestamp(subscription.cancel_at),
      canceled_at: isoTimestamp(subscription.canceled_at),
      trial_end: isoTimestamp(subscription.trial_end),
      cancel_at_period_end: subscription.cancel_at_period_end === true,
      currency: typeof subscription.currency === "string" ? subscription.currency : null,
      items,
    };
  });

  const hasMore = body.has_more === true;
  const last = subscriptions[subscriptions.length - 1];
  return {
    subscriptions,
    hasMore,
    nextCursor: hasMore ? (last?.id ?? null) : null,
  };
};
