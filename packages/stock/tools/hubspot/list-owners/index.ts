type HubSpotOwner = {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  userId?: number | null;
};

type OwnersResponse = {
  results?: HubSpotOwner[];
  paging?: {
    next?: {
      after?: string;
    };
  };
};

export default async (_input: Input, ctx: Context) => {
  const owners: Array<{
    id: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    userId: number | null;
  }> = [];

  let after: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const path =
      after === undefined
        ? "/crm/v3/owners?limit=100&archived=false"
        : `/crm/v3/owners?limit=100&archived=false&after=${encodeURIComponent(after)}`;
    const res = await ctx.fetch(path, { method: "GET" });

    if (!res.ok) {
      throw new Error(`GET /crm/v3/owners ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as OwnersResponse;
    for (const owner of body.results ?? []) {
      owners.push({
        id: owner.id ?? null,
        firstName: owner.firstName ?? null,
        lastName: owner.lastName ?? null,
        email: owner.email ?? null,
        userId: owner.userId ?? null,
      });
    }

    after = body.paging?.next?.after;
    if (after === undefined) break;
  }

  return { owners };
};
