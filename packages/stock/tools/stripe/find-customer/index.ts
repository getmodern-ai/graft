// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type StripeCustomer = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  created: number;
  currency: string | null;
  delinquent: boolean | null;
  balance: number;
};

type StripeCustomerList = {
  data: StripeCustomer[];
  has_more: boolean;
  next_page?: string | null;
};

// Stripe's search language quotes a value in double quotes and escapes with a backslash, so the
// backslash is escaped first and a quote in a name cannot end the value early.
const searchValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 10;
  const byEmail = input.query.includes("@");
  let requestPath: string;
  let stripePath: string;

  if (byEmail) {
    const params = new URLSearchParams({
      email: input.query,
      limit: String(limit),
    });
    if (input.cursor !== undefined) params.set("starting_after", input.cursor);
    requestPath = `/customers?${params.toString()}`;
    stripePath = "/v1/customers";
  } else {
    const params = new URLSearchParams({
      query: `name~"${searchValue(input.query)}"`,
      limit: String(limit),
    });
    if (input.cursor !== undefined) params.set("page", input.cursor);
    requestPath = `/customers/search?${params.toString()}`;
    stripePath = "/v1/customers/search";
  }

  const res = await ctx.fetch(requestPath, { headers: { "stripe-version": STRIPE_VERSION } });
  if (!res.ok) {
    throw new Error(`GET ${stripePath} ${res.status}: ${await res.text()}`);
  }

  const result = (await res.json()) as StripeCustomerList;
  const last = result.data[result.data.length - 1];
  const nextCursor = !result.has_more
    ? null
    : byEmail
      ? (last?.id ?? null)
      : typeof result.next_page === "string"
        ? result.next_page
        : null;

  return {
    customers: result.data.map((customer) => ({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      description: customer.description,
      created: new Date(customer.created * 1000).toISOString(),
      currency: customer.currency,
      delinquent: customer.delinquent,
      balance: customer.balance,
    })),
    hasMore: result.has_more,
    nextCursor,
  };
};
