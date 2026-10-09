type DealProperties = {
  dealname?: string | null;
  amount?: string | null;
  dealstage?: string | null;
  pipeline?: string | null;
  closedate?: string | null;
  hubspot_owner_id?: string | null;
};

type Deal = {
  id: string;
  properties?: DealProperties;
};

type DealsPage = {
  results?: Deal[];
  paging?: {
    next?: {
      after?: string;
    };
  };
};

const basePath =
  "/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,pipeline,closedate,hubspot_owner_id";

export default async (input: Input, ctx: Context) => {
  const query = input.query.toLocaleLowerCase();
  const maxPages = input.maxPages ?? 5;
  const matches: Array<{
    id: string;
    name: string;
    amount: string | null;
    stageId: string | null;
    pipelineId: string | null;
    closeDate: string | null;
    ownerId: string | null;
  }> = [];

  let scanned = 0;
  let after: string | undefined;
  let morePagesRemain = false;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const path = after === undefined ? basePath : `${basePath}&after=${encodeURIComponent(after)}`;
    const res = await ctx.fetch(path, { method: "GET" });
    if (!res.ok) {
      throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
    }

    const page = (await res.json()) as DealsPage;
    const deals = Array.isArray(page.results) ? page.results : [];
    scanned += deals.length;

    for (const deal of deals) {
      const properties = deal.properties ?? {};
      const name = properties.dealname;
      if (
        typeof name === "string" &&
        name.toLocaleLowerCase().includes(query) &&
        matches.length < 10
      ) {
        matches.push({
          id: deal.id,
          name,
          amount: properties.amount ?? null,
          stageId: properties.dealstage ?? null,
          pipelineId: properties.pipeline ?? null,
          closeDate: properties.closedate ?? null,
          ownerId: properties.hubspot_owner_id ?? null,
        });
      }
    }

    const nextAfter = page.paging?.next?.after;
    if (typeof nextAfter !== "string" || nextAfter.length === 0) {
      morePagesRemain = false;
      break;
    }

    morePagesRemain = true;
    after = nextAfter;
  }

  return {
    matches,
    scanned,
    complete: !morePagesRemain,
  };
};
