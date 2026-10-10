type BalanceAmount = {
  amount: number;
  currency: string;
};

function amounts(value: unknown, field: string): BalanceAmount[] {
  if (!Array.isArray(value)) {
    throw new Error(`GET /v1/balance returned an invalid ${field} list`);
  }

  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { amount?: unknown }).amount !== "number" ||
      typeof (entry as { currency?: unknown }).currency !== "string"
    ) {
      throw new Error(`GET /v1/balance returned an invalid ${field} entry`);
    }

    return {
      amount: (entry as { amount: number }).amount,
      currency: (entry as { currency: string }).currency,
    };
  });
}

export default async (input: Input, ctx: Context) => {
  void input;
  const res = await ctx.fetch("/balance");
  if (!res.ok) {
    throw new Error(`GET /v1/balance ${res.status}: ${await res.text()}`);
  }

  const balance = (await res.json()) as {
    available?: unknown;
    pending?: unknown;
    instant_available?: unknown;
    connect_reserved?: unknown;
    livemode?: unknown;
  };

  if (typeof balance.livemode !== "boolean") {
    throw new Error("GET /v1/balance returned an invalid livemode value");
  }

  const result: {
    available: BalanceAmount[];
    pending: BalanceAmount[];
    livemode: boolean;
    instant_available?: BalanceAmount[];
    connect_reserved?: BalanceAmount[];
  } = {
    available: amounts(balance.available, "available"),
    pending: amounts(balance.pending, "pending"),
    livemode: balance.livemode,
  };

  if (balance.instant_available !== undefined) {
    result.instant_available = amounts(balance.instant_available, "instant_available");
  }
  if (balance.connect_reserved !== undefined) {
    result.connect_reserved = amounts(balance.connect_reserved, "connect_reserved");
  }

  return result;
};
