const WORKSPACE_PROJECTS_QUERY =
  "query WorkspaceProjects { projects(first: 50) { nodes { id name state progress targetDate url lead { id name } } } }";

const TEAM_PROJECTS_QUERY =
  "query TeamProjects($teamId: String!) { team(id: $teamId) { projects(first: 50) { nodes { id name state progress targetDate url lead { id name } } } } }";

type GraphQLError = {
  message?: string;
};

type Project = {
  id: string;
  name: string;
  state: string;
  progress: number;
  targetDate: string | null;
  url: string;
  lead: { id: string; name: string } | null;
};

type ProjectsResponse = {
  data?: {
    projects?: { nodes: Project[] };
    team?: { projects: { nodes: Project[] } } | null;
  };
  errors?: GraphQLError[];
};

export default async (input: Input, ctx: Context) => {
  // Each document named in its own call, so the check reads it as a query (GRA-260).
  const res = input.teamId
    ? await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: TEAM_PROJECTS_QUERY, variables: { teamId: input.teamId } }),
      })
    : await ctx.fetch("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: WORKSPACE_PROJECTS_QUERY, variables: {} }),
      });

  if (!res.ok) {
    throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as ProjectsResponse;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }

  const projects = input.teamId ? body.data?.team?.projects.nodes : body.data?.projects?.nodes;

  if (!projects) {
    throw new Error(
      input.teamId
        ? "Linear returned no matching team or project list"
        : "Linear returned no project list",
    );
  }

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      state: project.state,
      progress: project.progress,
      targetDate: project.targetDate,
      url: project.url,
      lead: project.lead ? { id: project.lead.id, name: project.lead.name } : null,
    })),
  };
};
