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
};

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 10;
  let requestPath: string;
  let stripePath: string;

  if (input.query.includes("@")) {
    const params = new URLSearchParams({
      email: input.query,
      limit: String(limit),
    });
    requestPath = `/customers?${params.toString()}`;
    stripePath = "/v1/customers";
  } else {
    const escapedQuery = input.query.replace(/"/g, '\\"');
    const params = new URLSearchParams({
      query: `name~"${escapedQuery}"`,
      limit: String(limit),
    });
    requestPath = `/customers/search?${params.toString()}`;
    stripePath = "/v1/customers/search";
  }

  const res = await ctx.fetch(requestPath);
  if (!res.ok) {
    throw new Error(`GET ${stripePath} ${res.status}: ${await res.text()}`);
  }

  const result = (await res.json()) as StripeCustomerList;
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
  };
};
