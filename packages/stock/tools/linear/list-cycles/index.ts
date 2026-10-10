const ALL_CYCLES_QUERY =
  "query ListCycles { cycles(first: 50) { nodes { id number name startsAt endsAt progress team { id key } } } }";

const TEAM_CYCLES_QUERY =
  "query ListTeamCycles($teamId: ID!) { cycles(first: 50, filter: { team: { id: { eq: $teamId } } }) { nodes { id number name startsAt endsAt progress team { id key } } } }";

type Cycle = {
  id: string;
  number: number;
  name: string;
  startsAt: string;
  endsAt: string;
  progress: number;
  team: {
    id: string;
    key: string;
  };
};

type GraphQLResponse = {
  data?: {
    cycles?: {
      nodes?: Cycle[];
    };
  };
  errors?: Array<{ message?: string }>;
};

export default async (input: Input, ctx: Context) => {
  // Each document named in its own call, so the check reads it as a query (GRA-260).
  const res = input.teamId
    ? await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: TEAM_CYCLES_QUERY, variables: { teamId: input.teamId } }),
      })
    : await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: ALL_CYCLES_QUERY, variables: {} }),
      });

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const cycles = body.data?.cycles?.nodes;
  if (!cycles) {
    throw new Error("Linear GraphQL response did not include cycles");
  }

  return {
    cycles: cycles.map((cycle) => ({
      id: cycle.id,
      number: cycle.number,
      name: cycle.name,
      startsAt: cycle.startsAt,
      endsAt: cycle.endsAt,
      progress: cycle.progress,
      team: {
        id: cycle.team.id,
        key: cycle.team.key,
      },
    })),
  };
};
