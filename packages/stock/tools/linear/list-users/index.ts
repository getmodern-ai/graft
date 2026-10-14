const QUERY =
  "query ListUsers { users(first: 100) { nodes { id name displayName email active } } }";

type LinearUser = {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
};

type GraphQLResponse = {
  data?: {
    users?: {
      nodes?: LinearUser[];
    };
  };
  errors?: Array<{ message?: string }>;
};

export default async (_input: Input, ctx: Context) => {
  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: {} }),
  });

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const users = body.data?.users?.nodes;
  if (!users) {
    throw new Error("Linear GraphQL response did not include users");
  }

  return {
    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      active: user.active,
    })),
  };
};
