type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const idOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  const object = record(value);
  return typeof object.id === "string" ? object.id : null;
};

const isoTime = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nullableBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const customerResult = (customer: JsonRecord) => {
  const subscriptions = record(customer.subscriptions);
  const subscriptionData = array(subscriptions.data).map((rawSubscription) => {
    const subscription = record(rawSubscription);
    const items = record(subscription.items);
    const itemData = array(items.data);
    const firstItemWithStart = itemData
      .map(record)
      .find((item) => typeof item.current_period_start === "number");
    const firstItemWithEnd = itemData
      .map(record)
      .find((item) => typeof item.current_period_end === "number");

    return {
      id: nullableString(subscription.id),
      status: nullableString(subscription.status),
      current_period_start: isoTime(
        subscription.current_period_start ?? firstItemWithStart?.current_period_start,
      ),
      current_period_end: isoTime(
        subscription.current_period_end ?? firstItemWithEnd?.current_period_end,
      ),
      cancel_at_period_end: nullableBoolean(subscription.cancel_at_period_end),
      items: itemData.map((rawItem) => {
        const item = record(rawItem);
        const price = record(item.price);
        const recurring = record(price.recurring);
        return {
          price_id: nullableString(price.id),
          product_id: idOf(price.product),
          unit_amount: nullableNumber(price.unit_amount),
          currency: nullableString(price.currency),
          recurring_interval: nullableString(recurring.interval),
          quantity: nullableNumber(item.quantity),
        };
      }),
    };
  });

  return {
    found: true,
    id: nullableString(customer.id),
    name: nullableString(customer.name),
    email: nullableString(customer.email),
    phone: nullableString(customer.phone),
    description: nullableString(customer.description),
    created: isoTime(customer.created),
    currency: nullableString(customer.currency),
    balance: nullableNumber(customer.balance),
    delinquent: nullableBoolean(customer.delinquent),
    address: customer.address ?? null,
    subscriptions: subscriptionData,
  };
};

export default async (input: Input, ctx: Context) => {
  let customerId = input.customer;

  if (customerId === undefined) {
    const listPath = "/customers?limit=1";
    const listResponse = await ctx.fetch(listPath);
    if (!listResponse.ok) {
      throw new Error(`/v1/customers ${listResponse.status}: ${await listResponse.text()}`);
    }

    const list = record(await listResponse.json());
    const newest = record(array(list.data)[0]);
    if (typeof newest.id !== "string") return { found: false };
    customerId = newest.id;
  }

  const requestPath = `/customers/${encodeURIComponent(customerId)}?expand[]=subscriptions`;
  const displayPath = `/v1/customers/${customerId}`;
  const response = await ctx.fetch(requestPath);
  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new Error(`${displayPath} ${response.status}: ${await response.text()}`);
  }

  const customer = record(await response.json());
  if (customer.deleted === true) return { found: false, deleted: true };
  return customerResult(customer);
};
