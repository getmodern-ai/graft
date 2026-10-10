const QUERY =
  "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url priority state { id name } assignee { id name } labels { nodes { id name } } } } }";

type ToolInput = {
  id: string;
  stateId?: string;
  assigneeId?: string | null;
  priority?: number;
  labelIds?: string[];
  title?: string;
};
type GraphQLError = { message?: string };
type Issue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  state: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
};
type ResponseBody = {
  data?: { issueUpdate?: { success: boolean; issue: Issue | null } };
  errors?: GraphQLError[];
};

export default async (input: Input, ctx: Context) => {
  const values = input as ToolInput;
  const update: Record<string, string | number | null | string[]> = {};
  if (Object.hasOwn(values, "stateId")) update.stateId = values.stateId as string;
  if (Object.hasOwn(values, "assigneeId")) update.assigneeId = values.assigneeId as string | null;
  if (Object.hasOwn(values, "priority")) update.priority = values.priority as number;
  if (Object.hasOwn(values, "labelIds")) update.labelIds = values.labelIds as string[];
  if (Object.hasOwn(values, "title")) update.title = values.title as string;

  if (Object.keys(update).length === 0) {
    throw new Error("Provide at least one of stateId, assigneeId, priority, labelIds, or title");
  }

  const variables = { id: values.id, input: update };
  const res = await ctx.fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { updated: false, sent: variables };
  }
  if (!res.ok) throw new Error(`POST /graphql ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as ResponseBody;
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors[0]?.message ?? "Unknown error"}`);
  }
  const result = body.data?.issueUpdate;
  if (!result) throw new Error("Linear returned no issueUpdate result");
  if (!result.success) throw new Error("Linear reported that the issue was not updated");
  if (!result.issue) throw new Error("Linear reported success without returning the issue");

  return { updated: true, issue: result.issue };
};
