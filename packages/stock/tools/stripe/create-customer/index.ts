// Every path is from api.stripe.com's root, so a connection whose base URL lacks `/v1` still
// reaches the same endpoints (GRA-261; ADR 0010 as amended 2026-09-24, `ctx.fetch`'s `host`).
const STRIPE_HOST = "api.stripe.com";
// The API version every field below is read at, so the account's default cannot move them (GRA-261).
const STRIPE_VERSION = "2026-02-25.clover";

type StripeCustomer = {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
};

export default async (input: Input, ctx: Context) => {
  const form = new URLSearchParams();
  const sent: Record<string, string> = {};

  const add = (key: string, value: string | undefined) => {
    if (value !== undefined) {
      form.append(key, value);
      sent[key] = value;
    }
  };

  add("email", input.email);
  add("name", input.name);
  add("phone", input.phone);
  add("description", input.description);

  if (input.address !== undefined) {
    add("address[line1]", input.address.line1);
    add("address[line2]", input.address.line2);
    add("address[city]", input.address.city);
    add("address[state]", input.address.state);
    add("address[postal_code]", input.address.postal_code);
    add("address[country]", input.address.country);
  }

  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      add(`metadata[${key}]`, value);
    }
  }

  const res = await ctx.fetch("/v1/customers", {
    host: STRIPE_HOST,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_VERSION,
    },
    body: form,
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { created: false, sent };
  }

  if (!res.ok) {
    throw new Error(`POST /v1/customers ${res.status}: ${await res.text()}`);
  }

  const customer = (await res.json()) as StripeCustomer;
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    created: new Date(customer.created * 1000).toISOString(),
  };
};
