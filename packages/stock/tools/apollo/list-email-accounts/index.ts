type EmailAccount = {
  id?: string | null;
  email?: string | null;
  user_id?: string | null;
  type?: string | null;
  active?: boolean | null;
  default?: boolean | null;
};

type EmailAccountsResponse = {
  email_accounts?: EmailAccount[];
};

export default async (input: Input, ctx: Context) => {
  void input;
  const res = await ctx.fetch("/email_accounts", { method: "GET" });
  if (!res.ok) {
    throw new Error(`GET /api/v1/email_accounts ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as EmailAccountsResponse;
  const accounts = Array.isArray(data.email_accounts) ? data.email_accounts : [];

  return {
    email_accounts: accounts.map((account) => ({
      id: account.id ?? null,
      email: account.email ?? null,
      user_id: account.user_id ?? null,
      type: account.type ?? null,
      active: account.active ?? null,
      default: account.default ?? null,
    })),
  };
};
