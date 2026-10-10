// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type StripeProduct = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
};

type StripePrice = {
  id: string;
  unit_amount: number | null;
  currency: string;
  type: "one_time" | "recurring";
  recurring: {
    interval: string;
    interval_count: number;
  } | null;
  nickname: string | null;
  active: boolean;
  product: StripeProduct;
};

type StripePricesResponse = {
  data: StripePrice[];
  has_more: boolean;
};

type ListedPrice = {
  id: string;
  unit_amount: number | null;
  currency: string;
  type: "one_time" | "recurring";
  interval: string | null;
  interval_count: number | null;
  nickname: string | null;
  active: boolean;
};

type ListedProduct = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  prices: ListedPrice[];
};

export default async (input: Input, ctx: Context) => {
  const limit = input.limit ?? 20;
  const active = input.active ?? true;
  const query = new URLSearchParams();
  query.append("expand[]", "data.product");
  query.set("limit", String(limit));
  query.set("active", String(active));
  if (input.cursor !== undefined) query.set("starting_after", input.cursor);

  const res = await ctx.fetch(`/prices?${query.toString()}`, {
    headers: { "stripe-version": STRIPE_VERSION },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/prices ${res.status}: ${await res.text()}`);
  }

  const response = (await res.json()) as StripePricesResponse;
  const products: ListedProduct[] = [];
  const byProduct = new Map<string, ListedProduct>();

  for (const price of response.data) {
    const product = price.product;
    let listedProduct = byProduct.get(product.id);
    if (!listedProduct) {
      listedProduct = {
        id: product.id,
        name: product.name,
        description: product.description,
        active: product.active,
        prices: [],
      };
      byProduct.set(product.id, listedProduct);
      products.push(listedProduct);
    }

    listedProduct.prices.push({
      id: price.id,
      unit_amount: price.unit_amount,
      currency: price.currency,
      type: price.type,
      interval: price.type === "recurring" ? (price.recurring?.interval ?? null) : null,
      interval_count: price.type === "recurring" ? (price.recurring?.interval_count ?? null) : null,
      nickname: price.nickname,
      active: price.active,
    });
  }

  // The page is of prices, so the cursor is the last price's id and a product may continue on it.
  const last = response.data[response.data.length - 1];
  return {
    products,
    hasMore: response.has_more,
    nextCursor: response.has_more ? (last?.id ?? null) : null,
  };
};
