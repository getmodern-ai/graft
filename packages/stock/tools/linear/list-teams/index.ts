const QUERY = "query ListTeams { teams(first: 100) { nodes { id key name } } }";

type LinearResponse = {
  data?: {
    teams?: {
      nodes?: Array<{ id: string; key: string; name: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  void input;
  const variables = {};
  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const body = (await res.json()) as LinearResponse;
  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${JSON.stringify(body)}`);
  }
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }
  const teams = body.data?.teams?.nodes;
  if (!teams) {
    throw new Error("Linear GraphQL response did not include teams");
  }
  return {
    teams: teams.map((team) => ({ id: team.id, key: team.key, name: team.name })),
  };
};
