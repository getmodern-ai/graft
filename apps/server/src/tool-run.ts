import {
  type AgentDeps,
  getAgent,
  getToolByName,
  isPromoted,
  orNotFound,
  type Principal,
  type ServiceContext,
  ServiceError,
  type ToolDeps,
  type WorkingSetDeps,
} from "@graft/core";
import {
  authoredToolName,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  type McpDeps,
  NO_ELICITATION,
  runAuthoredTool,
} from "@graft/mcp";

/**
 * Running an authored tool as one of the person's agents from the console (GRA-208; ADR 0024, *The
 * console is a second caller of `acquire` and of a run*): `POST /api/agents/:id/tools/:vendor/:name/run`.
 * Setup's result step is its only caller, and the route is general in shape so a later screen's
 * Run is a decision about the screen and not about this.
 *
 * The run is `@graft/mcp`'s `runAuthoredTool` with the server's own `McpDeps`, exactly what a
 * first-class call over `/mcp` runs: the scope check, the input against the stored schema, the blob
 * door, the capability token, the sandbox and the ledger row. Synchronous, with the run's default
 * timeout (`DEFAULT_COMMAND_TIMEOUT_SECONDS`), and never a dry run.
 *
 * **Nothing in ADR 0008 enters the console.** A tool whose annotation is not read-only is refused
 * before the run, so the approval gate never asks and no pending action is opened for a click the
 * person made here; the channel is `NO_ELICITATION` besides. A tool outside the agent's working set
 * is refused too, as `/mcp` refuses a first-class call to a tool the agent does not list. Both are
 * `CONFLICT` with a reason; another person's agent, or a tool not in the toolbox, is not found.
 * Both are judged twice: here, for the answer, and again on the run's own read of the tool through
 * `AuthoredRunArgs.admit`, inside the agent's in-flight hold, so a republish or a demotion landing
 * between the two reads is refused the same way.
 */

/** The route's answer: the run's own result, or the run's refusal or failure with its sentence. */
export type AgentToolRunOutput =
  | { ok: true; result: unknown }
  | {
      ok: false;
      /** The refusal's `reason` (`input_invalid`, `connection_not_in_scope`, …), or null for a failure. */
      reason: string | null;
      /** The sentence a person reads: the refusal's message, or the runner's error. */
      message: string;
      /** The run's answer as `/mcp` would carry it. */
      answer: Record<string, unknown>;
    };

export type AgentToolRunDeps = {
  agent: AgentDeps;
  tool: ToolDeps;
  workingSet: WorkingSetDeps;
  /** The MCP endpoint's deps, whose sandbox, proxy key and ledger the run uses. */
  mcp: McpDeps;
};

function sentenceOf(answer: Record<string, unknown>): string {
  if (typeof answer.message === "string" && answer.message) return answer.message;
  if (typeof answer.error === "string" && answer.error) return answer.error;
  return "The tool did not answer.";
}

export async function runAgentTool(
  ctx: ServiceContext,
  principal: Principal,
  ids: { agentId: string; vendor: string; name: string },
  input: unknown,
  deps: AgentToolRunDeps,
): Promise<AgentToolRunOutput> {
  const agent = orNotFound(
    await getAgent(ctx, principal, ids.agentId, deps.agent),
    "Agent not found",
  );
  if (agent.revokedAt) {
    throw new ServiceError("CONFLICT", `${agent.name} is revoked, so it runs nothing`, {
      details: { reason: "agent_revoked" },
    });
  }
  const scope = { personId: principal.personId, agentId: agent.id };
  const wire = authoredToolName(ids.vendor, ids.name);
  const tool = orNotFound(
    await getToolByName(ctx, principal, { vendor: ids.vendor, name: ids.name }, deps.tool),
    `No tool named ${wire} is in this toolbox`,
  );
  /** Why the console will not run this tool as it stands: not read-only, or not promoted. */
  const unrunnable = async (subject: { id: string; readOnly: boolean }) => {
    if (!subject.readOnly) {
      return new ServiceError(
        "CONFLICT",
        `${wire} is not read-only, so running it asks for your approval first; the console runs read-only tools only, so run it from the harness, where the ask reaches you`,
        { details: { reason: "tool_not_read_only", tool: wire } },
      );
    }
    if (!(await isPromoted(ctx, scope, subject.id, deps.workingSet))) {
      return new ServiceError(
        "CONFLICT",
        `${wire} is not in ${agent.name}'s working set; promote it first, as the harness would`,
        { details: { reason: "tool_not_in_working_set", tool: wire } },
      );
    }
    return null;
  };
  const early = await unrunnable(tool);
  if (early) throw early;
  // Judged again on the run's own read of the tool, inside the agent's in-flight hold (Greptile on
  // #166): a republish that made it write-capable, or a demotion, between this read and the run's
  // is refused the same way rather than reaching the approval gate or the sandbox.
  const judged: { refusal: ServiceError | null } = { refusal: null };
  const run = await runAuthoredTool(deps.mcp, scope, {
    vendor: tool.vendor,
    name: tool.name,
    input,
    mode: { detached: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS, dryRun: false },
    channel: NO_ELICITATION,
    admit: async (current) => {
      const refusal = await unrunnable(current);
      judged.refusal = refusal;
      return refusal ? { reason: String(refusal.details?.reason), message: refusal.message } : null;
    },
  });
  if (judged.refusal) throw judged.refusal;
  if (!run.isError) return { ok: true, result: run.answer };
  const reason = typeof run.answer.reason === "string" ? run.answer.reason : null;
  return { ok: false, reason, message: sentenceOf(run.answer), answer: run.answer };
}
