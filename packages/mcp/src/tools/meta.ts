import {
  countWorkingSet,
  createAcquireJob,
  demoteTool,
  GOAL_MAX_LENGTH,
  getAcquireJob,
  getAgentScope,
  getConnection,
  getToolByName,
  HINTS_MAX_LENGTH,
  listConnections,
  listTools,
  listWorkingSet,
  promoteTool,
} from "@graft/core";
import { AUTH_SCHEMES } from "@graft/proxy/types";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { awaitJobNews, STATUS_WAIT_MS } from "../acquire/await";
import { acquireStatusOf } from "../acquire/shapes";
import { requireBuildApproval } from "../approval";
import { ASK_CARD_TOOL_META } from "../ask-card";
import { BLOB_RESULT_FACT } from "../blobs";
import {
  clampTimeout,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_DETACHED_TIMEOUT_SECONDS,
  DETACHED_ADVICE_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_DETACHED_TIMEOUT_SECONDS,
} from "../bounds";
import { toolAskResult } from "../card-client";
import {
  describeSchemes,
  readConnectionProposal,
  requestConnection,
  requestCredential,
} from "../connection-request";
import type { SessionContext } from "../context";
import { isPlainObject, toolRefusal, toolResult } from "../result";
import { runAuthoredTool } from "../run";
import { authoredToolName } from "../tool-names";
import { similarTools } from "./acquire-similar";
import { answerAsk } from "./answer-ask";
import { askStatus } from "./ask-status";
import { queryWords, rankTools } from "./find-tool.match";
import { startLink } from "./start-link";

/**
 * The fixed meta-tools every agent sees (CONTEXT.md, *Meta-tool*): the front door, `acquire` and
 * `acquire_status` (ADR 0004; the job behind them is `../acquire/job.ts`), the working set's own
 * controls — `find_tool`, `promote`, `demote`, `run_tool` (ADR 0003, ADR 0009) — and the two
 * connection handoffs, `request_connection` and `request_credential` (GRA-28;
 * `../connection-request.ts`). The advanced set is `authoring.ts`; the per-connection execute tools
 * are `execute.ts`.
 */

export type MetaTool = {
  definition: Tool;
  handle: (args: Record<string, unknown>, session: SessionContext) => Promise<CallToolResult>;
};

export const FIND_TOOL = "find_tool";
export const PROMOTE = "promote";
export const DEMOTE = "demote";
export const RUN_TOOL = "run_tool";
export const ACQUIRE = "acquire";
/** The arguments acquire reads — its inputSchema's properties; an argument outside this set is named back (GRA-130). */
const ACQUIRE_ARGS = new Set(["connectionId", "goal", "hints", "ignoreExisting"]);
export const ACQUIRE_STATUS = "acquire_status";
export const REQUEST_CONNECTION = "request_connection";
export const REQUEST_CREDENTIAL = "request_credential";

/**
 * A tool as `find_tool` answers it — enough for `promote`, the annotations a harness gates on (ADR
 * 0008), and the input schema `run_tool` needs where the list never refreshes (GRA-78).
 */
export type FoundTool = {
  vendor: string;
  name: string;
  tool: string;
  description: string;
  promoted: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
};

const toolKeyProperties = {
  vendor: {
    type: "string",
    description: 'The vendor slug the tool is authored against, e.g. "unleashed".',
  },
  name: { type: "string", description: 'The tool\'s kebab-case name, e.g. "list-orders".' },
} as const;

function readToolKey(
  args: Record<string, unknown>,
): { vendor: string; name: string } | { error: string } {
  const vendor = typeof args.vendor === "string" ? args.vendor.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!vendor || !name) return { error: "vendor and name must both be non-empty strings" };
  return { vendor, name };
}

const findTool: MetaTool = {
  definition: {
    name: FIND_TOOL,
    description:
      "Used first, before acquire, for a task no listed tool covers: searches the toolbox, every tool authored for this account, demoted ones included, by vendor, name and description, matching every word of the query in any order; a tool no version of which has passed its dry run is not listed. " +
      "Each hit carries vendor and name (the arguments promote, demote and run_tool take), its inputSchema (the shape run_tool's input must match), whether it is in the agent's working set, and its read-only and destructive hints. " +
      "A hit that is not promoted is one promote call from the agent's list. The answer also carries connections, every live connection in the agent's scope with the connectionId acquire takes, its vendor and its name. An empty answer leads to request_connection when the vendor has no connection in the agent's scope, otherwise to acquire against the connection named.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to match against vendor, name and description, case-insensitively.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  handle: async (args, { ctx, principal, scope, deps }) => {
    const query = typeof args.query === "string" ? args.query : "";
    if (queryWords(query).length === 0) {
      return toolRefusal(
        "input_invalid",
        "query must be a non-empty string with a word of two or more characters",
      );
    }
    const [tools, workingSet, scopeIds, allConnections] = await Promise.all([
      listTools(ctx, principal, deps.tool),
      listWorkingSet(ctx, scope, deps.workingSet),
      getAgentScope(ctx, scope, deps.agent),
      listConnections(ctx, principal, deps.connection),
    ]);
    // The connections acquire can author against, by id (GRA-125): a chat product's agent lists
    // no execute__ tools, so this is where it learns a connectionId.
    const inScope = new Set(scopeIds);
    const connections = allConnections
      .filter((connection) => inScope.has(connection.id) && connection.revokedAt === null)
      .map((connection) => ({
        connectionId: connection.id,
        vendor: connection.vendor,
        displayName: connection.displayName,
      }));
    const promoted = new Set(workingSet.map((entry) => entry.toolId));
    // Every word of the query, in any order, across vendor, name and description, ranked by where
    // the words hit (`find-tool.match.ts`, GRA-115). Ranking by use — how recently an agent ran the
    // tool, how many agents hold it — would read the ledger and the working-set records (ADR 0009,
    // ADR 0012); the alpha has too few tools per toolbox to need it.
    // A tool with no current version is what an acquire job that never passed its dry run leaves
    // (GRA-77): nothing runnable, so nothing to find — its versions and reports stay for the console.
    const hits: FoundTool[] = rankTools(
      tools.filter((tool) => tool.currentVersionId !== null),
      query,
    ).map((tool) => ({
      vendor: tool.vendor,
      name: tool.name,
      tool: authoredToolName(tool.vendor, tool.name),
      description: tool.description,
      promoted: promoted.has(tool.id),
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
    }));
    return toolResult({
      tools: hits,
      connections,
      note:
        hits.length === 0
          ? "Nothing in the toolbox matches. If the vendor is among connections, acquire authors a new tool against its connectionId; if not, request_connection comes first."
          : "promote a tool to add it to your list; run_tool runs one without promoting it.",
    });
  },
};

const promote: MetaTool = {
  definition: {
    name: PROMOTE,
    description:
      "Used for a tool find_tool found that is not in the agent's working set: adds it. " +
      "The tool then appears in the agent's list as vendor__name with its own schema once the list is re-fetched, and run_tool calls it by name before that. " +
      "Answers the working set's new size. Nothing is authored.",
    inputSchema: {
      type: "object",
      properties: toolKeyProperties,
      required: ["vendor", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, session) => {
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    const { ctx, principal, scope, deps, notifier } = session;
    const tool = await getToolByName(ctx, principal, key, deps.tool);
    if (!tool) return toolNotFound(key);
    // The same refusal a run gives (`../run.ts`): a tool no version of which passed its dry run is
    // not promotable, since the list entry would name nothing that runs (GRA-77).
    if (!tool.currentVersionId) {
      return toolRefusal(
        "tool_has_no_version",
        `${authoredToolName(tool.vendor, tool.name)} has no version that passed its dry run, so there is nothing to promote. acquire authors one.`,
      );
    }
    const change = await promoteTool(ctx, scope, tool.id, "agent", deps.workingSet);
    if (change.changed) notifier.changed(scope.agentId);
    return toolResult({
      tool: authoredToolName(tool.vendor, tool.name),
      promoted: true,
      changed: change.changed,
      workingSetSize: await countWorkingSet(ctx, scope, deps.workingSet),
    });
  },
};

const demote: MetaTool = {
  definition: {
    name: DEMOTE,
    description:
      "Used for a tool the agent no longer needs in its working set: removes it and keeps the list short. " +
      "The tool stays in the toolbox, one find_tool and promote away; nothing is deleted. " +
      "The tool list changes (tools/list_changed). Answers the working set's new size.",
    inputSchema: {
      type: "object",
      properties: toolKeyProperties,
      required: ["vendor", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handle: async (args, session) => {
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    const { ctx, principal, scope, deps, notifier } = session;
    const tool = await getToolByName(ctx, principal, key, deps.tool);
    if (!tool) return toolNotFound(key);
    const change = await demoteTool(ctx, scope, tool.id, "agent", deps.workingSet);
    if (change.changed) notifier.changed(scope.agentId);
    return toolResult({
      tool: authoredToolName(tool.vendor, tool.name),
      promoted: false,
      changed: change.changed,
      workingSetSize: await countWorkingSet(ctx, scope, deps.workingSet),
    });
  },
};

const runTool: MetaTool = {
  definition: {
    name: RUN_TOOL,
    description:
      "Runs a toolbox tool by vendor and name, for the case where it is not in the agent's visible list: the turn a tool was just published or promoted, or a client that snapshots the list per conversation. " +
      "The effect is exactly a first-class call: the input is validated against the tool's inputSchema, which the acquire result and find_tool's hits carry and an input_invalid refusal answers beside the problems, and the vendor's answer, or the tool's failure, comes back verbatim. " +
      "A tool that changes something may answer awaiting_approval with a url on its first call: a handoff whose next step is the person's, in the console; the same call with the same arguments, once they have answered, runs the tool. " +
      "With dryRun: true reads reach the vendor and every other method stops at the proxy with a preview of the request; the answer is a dry-run report and nothing changes at the vendor. " +
      `A call expected to take more than about ${DETACHED_ADVICE_SECONDS} seconds takes detached: true and timeoutSeconds up to ${MAX_DETACHED_TIMEOUT_SECONDS} (default ${DEFAULT_DETACHED_TIMEOUT_SECONDS}), and answers a processName that wait_for_process polls; a dry run is waited for whatever detached says. ` +
      `${BLOB_RESULT_FACT} ` +
      "Marked destructive because the hint is the carried tool's, which the host cannot know per call: the tool's own annotations are in find_tool's hit and the acquire result.",
    inputSchema: {
      type: "object",
      properties: {
        ...toolKeyProperties,
        input: {
          type: "object",
          description:
            "The tool's input, matching the inputSchema the acquire result or find_tool answered; absent for a tool that takes nothing.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Dry run (default false): reads real, writes previewed at the proxy, a report in the answer.",
        },
        detached: {
          type: "boolean",
          description:
            "Starts the run in the background and answers a processName at once, which wait_for_process polls.",
        },
        timeoutSeconds: {
          type: "integer",
          description: `Seconds before the run is killed. Waiting: default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}, maximum ${MAX_COMMAND_TIMEOUT_SECONDS}. Detached: default ${DEFAULT_DETACHED_TIMEOUT_SECONDS}, maximum ${MAX_DETACHED_TIMEOUT_SECONDS}.`,
          minimum: 1,
          maximum: MAX_DETACHED_TIMEOUT_SECONDS,
        },
      },
      required: ["vendor", "name"],
      additionalProperties: false,
    },
    // As destructive as the tool it carries, which a host cannot know per call; the tool's own hints
    // ride on the find_tool hit (GRA-114).
    annotations: { readOnlyHint: false, destructiveHint: true },
    // The carried tool's first call may answer the tool ask's card (GRA-116; `../tools.ts`).
    _meta: ASK_CARD_TOOL_META,
  },
  handle: async (args, session) => {
    const { deps, scope, channel } = session;
    const key = readToolKey(args);
    if ("error" in key) return toolRefusal("input_invalid", key.error);
    if (args.input !== undefined && !isPlainObject(args.input)) {
      return toolRefusal("input_invalid", "input must be an object matching the tool's schema");
    }
    const dryRun = args.dryRun === true;
    const detached = args.detached === true && !dryRun;
    const timeoutSeconds = clampTimeout(args.timeoutSeconds, detached);
    const run = await runAuthoredTool(deps, scope, {
      vendor: key.vendor,
      name: key.name,
      input: args.input ?? {},
      mode: { detached, timeoutSeconds, dryRun },
      channel,
    });
    return run.isError ? toolAskResult(session, run) : toolResult(run.answer);
  },
};

function toolNotFound(key: { vendor: string; name: string }): CallToolResult {
  return toolRefusal(
    "tool_not_found",
    `No tool named ${key.name} for ${key.vendor} is in this toolbox. find_tool searches it.`,
  );
}

/**
 * What `acquire`'s description says of a tool that reads a blob (GRA-190; ADR 0023): where the
 * ref the job dry-runs against comes from, and what the job does with none. A fact about the job
 * (`../acquire/job.ts`'s fixture blob), in the third person; the rule that the producing tool runs
 * first is the instructions' (`../session.ts`'s `BLOB_RULE`).
 */
export const ACQUIRE_BLOB_FACT =
  "For a tool that reads a file, the goal or hints may name the blob:// ref an earlier tool answered: the model puts it in the draft's test input and the dry run reads that blob; with no ref, or a dead one, the job mints a fixture blob of text for the dry run alone and says so in a progress line.";

/** The line a job carries before its runner has said anything — what `acquire` answers with at once. */
export const FIRST_PROGRESS_LINE =
  "Queued: Graft's model will read the vendor's documentation, draft the tool, prove it with reads, publish and dry-run it, then promote it into your working set. acquire_status with the jobId answers when there is news.";

const acquire: MetaTool = {
  definition: {
    name: ACQUIRE,
    description:
      "Used when find_tool found nothing that covers the task and the vendor has a connection in the agent's scope: starts the job in which Graft's model reads the vendor's documentation, writes the smallest module that makes the call, checks it, proves it with reads, publishes it, dry-runs it and promotes it into the agent's working set. " +
      "Waits a short while for the job: a job that finishes in time answers with result, as acquire_status does; otherwise answers { jobId, status, progress } and acquire_status reads the job from then on, itself waiting for news. " +
      "The first acquire against a connection may instead answer awaiting_approval with a url, unless the person granted the build approval when they confirmed the connection: a handoff whose next step is the person's, in the console or on the ask card; the same call with the same arguments, once they have answered, starts the job. " +
      "When the toolbox already holds a tool of the vendor whose name and description cover the goal, answers similar_tools_exist naming those tools with the inputSchema run_tool takes, and starts no job; the same call with ignoreExisting: true starts one. " +
      `${ACQUIRE_BLOB_FACT}`,
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection to author against, one in the agent's scope.",
        },
        goal: { type: "string", description: "What the tool must do, in a sentence or two." },
        hints: {
          type: "string",
          description:
            "Anything already known: an endpoint, a documentation URL, a field name, or the blob:// ref an earlier tool answered when the tool is to read that file.",
        },
        ignoreExisting: {
          type: "boolean",
          description:
            "Build even though similar_tools_exist named tools that look like the goal; false unless none of them fits.",
        },
      },
      required: ["connectionId", "goal"],
      additionalProperties: false,
    },
    // Both hints said outright: unset, MCP reads destructiveHint as true, and a host tags the tool so
    // (GRA-114). acquire dry-runs and never writes at the vendor (ADR 0004).
    annotations: { readOnlyHint: false, destructiveHint: false },
    // The ask card renders for this tool's results (GRA-84): a build approval in place, or the link.
    _meta: ASK_CARD_TOOL_META,
  },
  /**
   * The door to the loop (ADR 0004). In order: the arguments; the connection in the agent's scope —
   * the same check every run makes, before anything else, and a connection outside it points at
   * `request_connection` (GRA-28); a model to answer at all; the **build approval** (ADR 0008:
   * `acquire` against a connection asks once per agent per connection), through the session's
   * channel, so an unanswered ask returns GRA-23's `awaiting_approval` and the next call finds the
   * answer; then the job row, and the runner woken. The call returns the moment the row exists —
   * the loop is minutes long and a tool call is not (ADR 0004's client-compatibility risk).
   */
  handle: async (args, session) => {
    // An argument acquire does not read is named back, so `task` for `goal` is a fixable refusal,
    // not a silent drop (GRA-130); the answer lists the accepted set.
    const unrecognised = Object.keys(args).filter((key) => !ACQUIRE_ARGS.has(key));
    const alsoUnrecognised =
      unrecognised.length > 0
        ? ` (${unrecognised.join(", ")} ${unrecognised.length === 1 ? "is" : "are"} not an acquire argument; it takes ${[...ACQUIRE_ARGS].join(", ")})`
        : "";
    const connectionId = typeof args.connectionId === "string" ? args.connectionId.trim() : "";
    if (!connectionId) {
      return toolRefusal(
        "input_invalid",
        `connectionId is required, a connection in the agent's scope${alsoUnrecognised}`,
      );
    }
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal || goal.length > GOAL_MAX_LENGTH) {
      return toolRefusal(
        "input_invalid",
        `goal is required, a sentence or two on what the tool must do (1 to ${GOAL_MAX_LENGTH} characters)${alsoUnrecognised}`,
      );
    }
    if (args.hints !== undefined && typeof args.hints !== "string") {
      return toolRefusal("input_invalid", "hints must be a string");
    }
    const hints = typeof args.hints === "string" ? args.hints.trim() : "";
    if (hints.length > HINTS_MAX_LENGTH) {
      return toolRefusal("input_invalid", `hints must be at most ${HINTS_MAX_LENGTH} characters`);
    }
    if (args.ignoreExisting !== undefined && typeof args.ignoreExisting !== "boolean") {
      return toolRefusal("input_invalid", "ignoreExisting must be a boolean when given");
    }

    const { ctx, principal, scope, deps, channel } = session;
    const scopeIds = await getAgentScope(ctx, scope, deps.agent);
    if (!scopeIds.includes(connectionId)) {
      return toolRefusal(
        "connection_not_in_scope",
        `Connection ${connectionId} is not in this agent's scope, so nothing can be authored against it. request_connection proposes a new connection for the person to confirm; an existing one is added to the scope in the console.`,
      );
    }
    if (!deps.model) {
      return toolRefusal(
        "acquire_unconfigured",
        "This deployment has no model configured, so Graft cannot author a tool. Say so rather than retrying; the advanced tools (write_file, check_tool, publish_tool) still let you drive the loop yourself.",
      );
    }
    // The toolbox first (GRA-154): a tool of this vendor whose name and description cover the goal
    // is answered, not rebuilt — on 2026-09-21 an agent built a third copy of a listing tool its
    // toolbox held twice. `ignoreExisting: true` is the agent saying none of them fits.
    if (args.ignoreExisting !== true) {
      const connection = await getConnection(ctx, principal, connectionId, deps.connection);
      const vendor = connection?.vendor;
      if (vendor) {
        const tools = await listTools(ctx, principal, deps.tool);
        const similar = similarTools(
          tools.filter((tool) => tool.vendor === vendor && tool.currentVersionId !== null),
          goal,
        );
        if (similar.length > 0) {
          const named = similar
            .map((tool) => `${authoredToolName(tool.vendor, tool.name)} — ${tool.description}`)
            .join("; ");
          return toolRefusal(
            "similar_tools_exist",
            `The toolbox already holds ${similar.length === 1 ? "a tool" : `${similar.length} tools`} that look like this goal: ${named}. Run one with run_tool { vendor, name, input } (each carries its inputSchema below), or call acquire again with ignoreExisting: true if none of them fits.`,
            {
              tools: similar.map((tool) => ({
                vendor: tool.vendor,
                name: tool.name,
                tool: authoredToolName(tool.vendor, tool.name),
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
              })),
            },
          );
        }
      }
    }
    // One deadline for the whole call: the build approval's wait and the job's wait share it, so
    // a call is never open for twice the configured limit (Greptile on #99).
    const deadline = Date.now() + Math.max(0, deps.handoff.waitMs);
    const gate = await requireBuildApproval(ctx, scope, connectionId, deps, channel);
    if (!gate.pass) return toolAskResult(session, gate);

    const job = await createAcquireJob(
      ctx,
      scope,
      {
        connectionId,
        goal,
        hints: hints || null,
        firstProgressLine: FIRST_PROGRESS_LINE,
      },
      deps.acquireJob,
    );
    deps.acquireRunner?.kick();
    // Hold the call for the approvals' wait (GRA-125; `../acquire/await.ts`): a job that settles
    // in time answers with its result, and the model never has a chance to be impatient.
    const settled = await awaitJobNews(ctx, scope, job.id, deps, {
      sinceProgress: Number.POSITIVE_INFINITY,
      maxWaitMs: deadline - Date.now(),
    });
    return toolResult(acquireStatusOf(settled ?? job));
  },
};

const acquireStatus: MetaTool = {
  definition: {
    name: ACQUIRE_STATUS,
    description:
      "Used with the jobId acquire answered while the job is queued or running: reads the job, waiting a short while for news, a progress line newer than the caller has seen (after, the count of lines already seen) or the end, so a call answers when there is something new. " +
      "Answers status, the progress lines so far, the attempt count and, once the job has settled, result. " +
      "On succeeded, result.tool is the new tool's wire name, vendor__name, with result.vendor, result.name and result.inputSchema as run_tool takes them; the tool is callable first-class once the tool list refreshes and through run_tool before that. " +
      "On failed, result.failure names the cause in one word, result.message says it in a sentence, and result.lastDiagnostics and result.tried carry what the job saw.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The id acquire returned." },
        after: {
          type: "integer",
          minimum: 0,
          description:
            "How many progress lines the caller has seen; the call waits for a newer one or the end. Unset, the count as of the call.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  handle: async (args, { ctx, scope, deps }) => {
    const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
    if (!jobId) return toolRefusal("input_invalid", "jobId must be a string");
    if (
      args.after !== undefined &&
      !(typeof args.after === "number" && Number.isInteger(args.after) && args.after >= 0)
    ) {
      return toolRefusal("input_invalid", "after must be a non-negative integer when given");
    }
    const job = await getAcquireJob(ctx, scope, jobId, deps.acquireJob);
    if (!job) {
      return toolRefusal(
        "job_not_found",
        `No acquire job ${jobId} was started by this agent. The id is the one acquire answered with.`,
      );
    }
    // Wait for news rather than answer the same lines again (GRA-125): the approvals' wait bounds
    // the hold, so a deployment that answers approvals at once answers this at once too.
    const news = await awaitJobNews(ctx, scope, jobId, deps, {
      sinceProgress: typeof args.after === "number" ? args.after : job.progress.length,
      maxWaitMs: Math.min(STATUS_WAIT_MS, deps.handoff.waitMs),
    });
    return toolResult(acquireStatusOf(news ?? job));
  },
};

const requestConnectionTool: MetaTool = {
  definition: {
    name: REQUEST_CONNECTION,
    description:
      // Capability facts alone, in the fewest words that still name every answer shape (GRA-111);
      // GRA-121 cut what ChatGPT's classifier read as risk handling — the field-by-field account of
      // what the person types, and the reconnect and rotation cases — which the console page and
      // the refusal messages carry instead.
      "Used when the vendor a task needs has no connection in the agent's scope. " +
      "Takes a proposal (hosts, auth scheme and its parameters, documentation URL) and answers a handoff url: the person checks the proposal in the console and completes it there. " +
      "Hosts are public https hosts; sign-in endpoints (the hosts of authorizeUrl and tokenUrl, and Google's) are set aside and named in the answer. " +
      "A public API that documents no auth is scheme none: the person confirms it. For oauth_authorization_code the proposal carries authorizeUrl, tokenUrl and scopes, and the person completes the consent from the console (redirectUri in the awaiting answer). " +
      "A vendor a link provider covers is connected by a sign-in at the vendor on the provider's page, from the card or the console. " +
      "The call waits a short while for the person, then answers awaiting_connection with a url, the same url until they have finished, then connected; the same proposal, repeated, picks the ask up. " +
      "Connected, the connection is in the agent's scope with its execute__<connectionId> tool in the list; the page also offers to allow building against it, on by default, so acquire against the connection starts without a second link. " +
      "A connection the person already has for the same vendor and hosts is not made twice: in the agent's scope, connected at once; made for another of their agents, awaiting_scope with a url, answered by the person in the console (no new connection, nothing entered), then connected on the repeated call; otherwise connection_exists names it and the next step. " +
      "A vendor this deployment's API gateway covers connects with no person step.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description:
            'A kebab-case vendor slug, e.g. "unleashed": the key tools authored against this connection are bound to.',
        },
        displayName: {
          type: "string",
          description:
            'What the person will see, e.g. "Acme Unleashed (production)". Defaults to the vendor slug.',
        },
        primaryHost: {
          type: "string",
          description:
            'The https base URL vendor-relative paths resolve against, e.g. "https://api.unleashedsoftware.com".',
        },
        hosts: {
          type: "array",
          items: { type: "string" },
          description:
            "Other hostnames the connection may reach (an SDK that spans several hosts); the primary's is included on its own. Sign-in endpoints belong in schemeConfig and are set aside here.",
        },
        scheme: {
          type: "string",
          enum: [...AUTH_SCHEMES],
          description:
            "The auth scheme the vendor documents, as the proxy names them. A vendor a link provider covers is connected by that provider under the scheme the vendor documents.",
        },
        schemeConfig: {
          type: "object",
          additionalProperties: { type: "string" },
          description: `The scheme's parameters, e.g. { "headerName": "x-api-key" } for api_key_header. Per scheme: ${describeSchemes()}. What the person types is the console form's, not the proposal's.`,
        },
        docsUrl: {
          type: "string",
          description:
            "The documentation page the proposal was read from, for the person to check.",
        },
      },
      required: ["vendor", "primaryHost", "scheme"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    // The ask card renders for this tool's results (GRA-84): a keyless confirmation in place, or the link.
    _meta: ASK_CARD_TOOL_META,
  },
  handle: async (args, session) => {
    const { ctx, scope, deps, notifier } = session;
    const input = readConnectionProposal(args);
    if ("error" in input) return toolRefusal("input_invalid", input.error);
    const outcome = await requestConnection(ctx, scope, input, deps, notifier);
    return outcome.isError ? toolAskResult(session, outcome) : toolResult(outcome.answer);
  },
};

const requestCredentialTool: MetaTool = {
  definition: {
    name: REQUEST_CREDENTIAL,
    description:
      "Used when a tool's call comes back with the vendor's 401 or 403, or the person reports a rotated key: asks the person to re-enter the credential of a connection in the agent's scope, in the console, and answers a handoff url. This tool takes no credential. " +
      "The re-entry replaces the credential on the existing connection and changes no approval; a revoked connection is reconnected by it. " +
      "The call waits a short while for the person, then answers awaiting_credential with a url, the same url on every call until they have finished, then connected; the same call, repeated, picks the ask up.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description:
            "The connection whose credential the vendor refused: the id in execute__<connectionId>.",
        },
        reason: {
          type: "string",
          description:
            "What the vendor said, in a sentence, shown to the person as the agent's words.",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    // The ask card renders for this tool's results too (GRA-84), with the console button alone.
    _meta: ASK_CARD_TOOL_META,
  },
  handle: async (args, session) => {
    const { ctx, scope, deps } = session;
    const connectionId = typeof args.connectionId === "string" ? args.connectionId : "";
    if (!connectionId.trim()) {
      return toolRefusal("input_invalid", "connectionId must be a non-empty string");
    }
    const reason = typeof args.reason === "string" ? args.reason : undefined;
    const outcome = await requestCredential(
      ctx,
      scope,
      { connectionId, ...(reason === undefined ? {} : { reason }) },
      deps,
    );
    return outcome.isError ? toolAskResult(session, outcome) : toolResult(outcome.answer);
  },
};

/**
 * In the order the list carries them: the loop's tools first, the connection handoffs, and last
 * the ask card's own three tools, which a host hides from the model (`./answer-ask.ts`,
 * `./start-link.ts`, `./ask-status.ts`).
 */
export const META_TOOLS: readonly MetaTool[] = [
  acquire,
  acquireStatus,
  findTool,
  promote,
  demote,
  runTool,
  requestConnectionTool,
  requestCredentialTool,
  answerAsk,
  startLink,
  askStatus,
];
