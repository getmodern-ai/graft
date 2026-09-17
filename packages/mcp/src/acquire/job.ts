import { type ModuleFile, readModuleSources } from "@graft/check";
import {
  type AgentScope,
  appendAcquireJobProgress,
  appendAcquireTrace,
  completeAcquireJob,
  finishAcquireAttempt,
  getAgentScope,
  getBuildApproval,
  getConnection,
  heartbeatAcquireJob,
  listAcquireAttempts,
  type Principal,
  recordAcquireJobTokens,
  redactValue,
  type ServiceContext,
  ServiceError,
  secretFieldNamesFor,
  startAcquireAttempt,
} from "@graft/core";
import type {
  AcquireAttemptRow,
  AcquireJobRow,
  RunnableAcquireJob,
} from "@graft/db/repo/acquire-job";
import type { AcquireAttemptOutcome, AcquireTraceKind } from "@graft/db/schema/acquire-job";
import {
  answerAllowed,
  type DocPage,
  type DryRunSummary,
  isValidUsage,
  type ModelAnswer,
  type ModelConversation,
  type ModelDiagnostic,
  type ModelSituation,
  type ModelUsage,
  type ModuleDraft,
  type ProofRead,
} from "@graft/model";
import { hostSetOf } from "@graft/proxy/credential-source";
import { isRedirect } from "@graft/proxy/redirects";
import type { PublishOutcome } from "@graft/publish";
import type { SandboxHandle } from "@graft/sandbox";
import { draftPath, sandboxPath, toolboxIdOf } from "@graft/toolbox";
import { NO_ELICITATION } from "../approval";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from "../bounds";
import type { McpDeps } from "../deps";
import { promotePublished } from "../promote";
import {
  type DryRunReport,
  readDryRunReport,
  runAuthoredTool,
  runModule,
  runWithCapability,
} from "../run";
import { errorMessage, openAgentSandbox } from "../sandbox";
import { authoredToolName } from "../tool-names";
import { EXECUTE_CLAIM } from "../tools/execute";
import {
  type AcquireAttemptSummary,
  type AcquireConfig,
  type AcquireFailure,
  type AcquireFailureKind,
  type AcquireSuccess,
  DEFAULT_ACQUIRE_CONFIG,
} from "./shapes";

/**
 * The **acquire** job's inner loop (CONTEXT.md, *Acquire*; ADR 0004: Graft holds the pen; ADR 0012:
 * L0 and L1, and everything recorded from day one). One job, one model conversation, in the
 * authoring skill's order: read the documentation, write the module, check it, prove it with
 * reads, publish with a test input, dry-run, and on a failed dry run diagnose and try again with a
 * changed module — bounded by the attempt count and the token ceiling (`AcquireConfig`), and by a
 * turn budget so a model that only ever asks for more documentation cannot run for ever inside the
 * ceiling. On success the tool is promoted for the agent that asked and `tools/list_changed` fires
 * exactly as `publish_tool`'s promotion does (`../promote.ts`); on failure the result names the bound
 * or the reason, the last diagnostics, and what was tried.
 *
 * **The model only answers.** The job owns every tool: it reads pages through the server-side page
 * reader, writes the draft onto the agent's sandbox under the job's own drafts path, runs the check,
 * makes each proof read through the connection's execute path with the dry-run claim on
 * (`runWithCapability`, claim `execute`), publishes through GRA-18's publish, and dry-runs through
 * the same path a first-class call takes. The model is never handed a credential, the capability
 * token, or a route to the vendor; what it sees of a vendor is the text the job hands back, with
 * credentials redacted before it is stored (`@graft/core`'s `redactText`).
 *
 * **Consent never moves inside** (ADR 0004, ADR 0006, ADR 0008). The build approval was the
 * meta-tool's to require before the job existed, and is required to still stand when the job runs.
 * Nothing here enters a credential. Nothing here makes a write to the vendor: proof reads are `GET`s
 * under the dry-run claim, and the dry run's token stops every other method at the proxy. The first
 * real write is the agent's, through the published tool, where ADR 0008's ask happens.
 *
 * **Every draft is an attempt**, whether the check, a proof read, the publish or the dry run stopped
 * it — so a module that fails the check spends an attempt as surely as one whose dry run fails.
 * `GRAFT_ACQUIRE_MAX_ATTEMPTS` defaults to four for that reason (`@graft/env`). Every attempt is a
 * row with its files, its outcome, the version it published and the model's own line about it;
 * every step is a trace line; every dry-run report is on the version row the attempt names.
 *
 * The job holds the agent in flight for its whole length (ADR 0009: the sweep never demotes under a
 * run), and releases in `finally`. It stamps the job's heartbeat while it works so a runner in another
 * process — after a restart — can tell a job that is being worked from one whose process died
 * (`./runner.ts`). A resumed job starts its conversation over; the attempts already made still count.
 */

/** The situations the model may see at most — a bound on a conversation, whatever the token ceiling. */
export function turnBudgetFor(maxAttempts: number): number {
  return maxAttempts * 6 + 6;
}

/** How many pages one `read_docs` answer may name, and how many proof reads one draft may ask for. */
export const MAX_DOCS_PER_TURN = 5;
export const MAX_PROOF_READS = 5;

/** How much of a proof read's body the model is shown; enough to see a shape, not a catalogue. */
export const PROOF_BODY_CHARS = 4_000;

/** How often the job stamps `heartbeat_at`; the runner's stale bound is a multiple of it. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** The probe module every proof read runs through — one `GET` of the path it is handed, and the answer's shape. */
export const PROBE_MODULE = [
  "export default async (input, ctx) => {",
  "  const res = await ctx.fetch(input.path);",
  "  const text = await res.text();",
  "  return {",
  "    status: res.status,",
  "    ok: res.ok,",
  '    location: res.headers.get("location"),',
  '    contentType: res.headers.get("content-type"),',
  `    body: text.slice(0, ${PROOF_BODY_CHARS}),`,
  "  };",
  "};",
  "",
].join("\n");

/** Where the probe lives in the job's drafts: beside the attempts, under a name no attempt takes. */
export function probePath(jobId: string): string {
  return `${draftPath(jobId)}/.probe`;
}

/** Where attempt `n`'s draft is written in the toolbox. */
export function attemptDraftPath(jobId: string, attemptNumber: number): string {
  return `${draftPath(jobId)}/a${attemptNumber}`;
}

export type RunAcquireJobOptions = {
  heartbeatMs?: number;
  now?: () => Date;
};

/** How the loop ends early: thrown from inside, caught once at the top, written as the result. */
class JobEnded extends Error {
  constructor(readonly result: AcquireFailure) {
    super(result.message);
    this.name = "JobEnded";
  }
}

type OpenAttempt = {
  row: AcquireAttemptRow;
  number: number;
  draft: ModuleDraft;
  usage: ModelUsage;
  /** Whether a proof read failed — what an attempt the model then rewrote is closed as. */
  proofFailed: boolean;
};

/**
 * Run one claimed job to its end. Returns the job row as completed, or null when the job vanished
 * from under the runner (its agent deleted). Never throws for a reason the job could record: a
 * failure of the loop itself — the database down at the last write, say — is rethrown for the
 * runner to log, since there is nowhere left to write it.
 */
export async function runAcquireJob(
  deps: McpDeps,
  claimed: RunnableAcquireJob,
  options: RunAcquireJobOptions = {},
): Promise<AcquireJobRow | null> {
  const scope: AgentScope = { personId: claimed.personId, agentId: claimed.job.agentId };
  const release = deps.inFlight?.begin(scope.agentId);
  const ctx: ServiceContext = { db: deps.db };
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    heartbeatAcquireJob(ctx, scope, claimed.job.id, deps.acquireJob).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await new AcquireLoop(deps, claimed, scope).run();
  } finally {
    clearInterval(heartbeat);
    release?.();
  }
}

class AcquireLoop {
  private readonly ctx: ServiceContext;
  private readonly principal: Principal;
  private readonly config: AcquireConfig;
  private readonly job: AcquireJobRow;
  private readonly redaction: { secretValues: string[]; secretFieldNames: string[] };
  private readonly tried: AcquireAttemptSummary[] = [];
  private attemptsMade: number;
  private tokensSpent: number;
  private turns = 0;
  private lastDiagnostics: unknown = null;
  private open: OpenAttempt | null = null;
  private handle: SandboxHandle | null = null;
  private probeWritten = false;

  constructor(
    private readonly deps: McpDeps,
    claimed: RunnableAcquireJob,
    private readonly scope: AgentScope,
  ) {
    this.ctx = { db: deps.db };
    this.principal = { personId: scope.personId };
    this.config = deps.acquire ?? DEFAULT_ACQUIRE_CONFIG;
    this.job = claimed.job;
    this.attemptsMade = claimed.job.attempts;
    this.tokensSpent = claimed.job.tokenSpend;
    this.redaction = { secretValues: [], secretFieldNames: [] };
  }

  async run(): Promise<AcquireJobRow | null> {
    try {
      const success = await this.loop();
      await this.trace(
        "result",
        `Done: ${success.tool} v${success.version} is published and promoted.`,
        {
          data: { ...success },
        },
      );
      return await completeAcquireJob(
        this.ctx,
        this.scope,
        this.job.id,
        { status: "succeeded", result: { ...success }, toolId: success.toolId },
        this.deps.acquireJob,
      );
    } catch (error) {
      const failure =
        error instanceof JobEnded
          ? error.result
          : this.failure("job_failed", `The job failed: ${errorMessage(error)}`, {
              error: errorMessage(error),
            });
      await this.closeOpen(this.openOutcome(), failure.message).catch(() => undefined);
      await this.trace("result", `Failed (${failure.failure}): ${failure.message}`, {
        data: { ...failure },
      }).catch(() => undefined);
      await appendAcquireJobProgress(
        this.ctx,
        this.scope,
        this.job.id,
        [`Stopped: ${failure.message}`],
        this.deps.acquireJob,
      ).catch(() => undefined);
      return completeAcquireJob(
        this.ctx,
        this.scope,
        this.job.id,
        { status: "failed", result: { ...failure } },
        this.deps.acquireJob,
      );
    }
  }

  /** The loop proper; returns on success, throws `JobEnded` otherwise. */
  private async loop(): Promise<AcquireSuccess> {
    const model = this.deps.model;
    if (!model) {
      throw this.end(
        "model_failed",
        "This deployment has no model configured, so the job cannot run.",
        null,
      );
    }

    // The connection, the scope and the approval as they stand now, not as they stood when the job
    // was queued — a revoke or a scope change in between is a reason to stop, not to run.
    const connection = await getConnection(
      this.ctx,
      this.principal,
      this.job.connectionId,
      this.deps.connection,
    );
    if (!connection || connection.revokedAt) {
      throw this.end(
        "connection_unavailable",
        `Connection ${this.job.connectionId} ${connection ? "was revoked" : "no longer exists"}, so there is nothing to author against.`,
        null,
      );
    }
    const scopeIds = await getAgentScope(this.ctx, this.scope, this.deps.agent);
    if (!scopeIds.includes(connection.id)) {
      throw this.end(
        "connection_unavailable",
        `Connection ${connection.id} is no longer in this agent's scope.`,
        null,
      );
    }
    if (!(await getBuildApproval(this.ctx, this.scope, connection.id, this.deps.approval))) {
      throw this.end(
        "build_approval_missing",
        `The person's approval for code to run against ${connection.displayName} for this agent no longer stands (ADR 0008). Call acquire again to ask afresh.`,
        null,
      );
    }
    this.redaction.secretFieldNames = secretFieldNamesFor(
      connection.scheme,
      connection.schemeConfig,
    );

    if (this.attemptsMade > 0) {
      await this.abandonStaleAttempts();
      await this.progress(
        `Resumed after an interruption: ${this.attemptsMade} of ${this.config.maxAttempts} attempts used, ${this.tokensSpent} tokens spent.`,
      );
    }
    await this.progress(
      `Authoring "${this.job.goal}" against ${connection.displayName} (${connection.vendor}). Reads reach the vendor for real; every write is previewed at the proxy and nothing changes there.`,
    );

    const skill = (await this.deps.skills()).find((s) => s.name === "authoring-a-tool");
    const conversation = model.open({
      jobId: this.job.id,
      personId: this.scope.personId,
      goal: this.job.goal,
      hints: this.job.hints,
      connection: {
        id: connection.id,
        vendor: connection.vendor,
        displayName: connection.displayName,
        scheme: connection.scheme,
        primaryHost: connection.primaryHost,
        hosts: connection.hosts,
      },
      skill: skill?.content ?? "",
      budget: { maxAttempts: this.config.maxAttempts, tokenCeiling: this.config.tokenCeiling },
    });
    await this.trace("model", `Opened a conversation with the ${model.name} model.`);

    let situation: ModelSituation = { kind: "goal" };
    for (;;) {
      const answer = await this.turn(conversation, situation);
      switch (answer.kind) {
        case "read_docs": {
          await this.progress(answer.note);
          situation = { kind: "docs", pages: await this.readDocs(answer.urls) };
          continue;
        }
        case "give_up": {
          await this.closeOpen(this.openOutcome(), answer.reason);
          throw this.end("model_gave_up", `The model gave up: ${answer.reason}`, {
            reason: answer.reason,
            last: this.lastDiagnostics,
          });
        }
        case "proceed": {
          const attempt = this.open;
          if (situation.kind !== "proof" || !attempt) {
            throw this.end(
              "model_failed",
              `The model answered "proceed" to ${situation.kind}, which only a proof result admits.`,
              null,
            );
          }
          await this.trace(
            "model",
            `Proceeding to publish attempt ${attempt.number}: ${answer.note}`,
            {
              attempt: attempt.number,
            },
          );
          const next = await this.publishAndDryRun(attempt, connection.id, connection.vendor);
          if ("success" in next) return next.success;
          situation = next.situation;
          continue;
        }
        case "write_module": {
          if (this.open) await this.closeOpen(this.openOutcome(), answer.note);
          if (this.attemptsMade >= this.config.maxAttempts) {
            throw this.end(
              "attempt_budget",
              `The attempt budget of ${this.config.maxAttempts} is spent; the last attempt's diagnostics are in lastDiagnostics.`,
              this.lastDiagnostics,
            );
          }
          const attempt = await this.openAttempt(answer.draft, answer.note);
          await this.progress(`Attempt ${attempt.number}: ${answer.note}`);
          const checked = await this.check(attempt);
          if (checked) {
            situation = checked;
            continue;
          }
          if (attempt.draft.proofReads.length > 0) {
            situation = {
              kind: "proof",
              attempt: attempt.number,
              reads: await this.prove(attempt, connection),
            };
            continue;
          }
          const next = await this.publishAndDryRun(attempt, connection.id, connection.vendor);
          if ("success" in next) return next.success;
          situation = next.situation;
          continue;
        }
      }
    }
  }

  /** One model turn: the budget, the cost, the ceiling, and whether the answer fits the question. */
  private async turn(
    conversation: ModelConversation,
    situation: ModelSituation,
  ): Promise<ModelAnswer> {
    this.turns += 1;
    const budget = turnBudgetFor(this.config.maxAttempts);
    if (this.turns > budget) {
      await this.closeOpen(this.openOutcome(), "the turn budget ran out");
      throw this.end(
        "turn_budget",
        `The model was asked ${budget} times without the loop ending; the last diagnostics are in lastDiagnostics.`,
        this.lastDiagnostics,
      );
    }
    let reply: Awaited<ReturnType<ModelConversation["turn"]>>;
    try {
      reply = await conversation.turn(situation);
    } catch (error) {
      await this.closeOpen(this.openOutcome(), `the model failed: ${errorMessage(error)}`);
      throw this.end(
        "model_failed",
        `The model failed to answer ${situation.kind}: ${errorMessage(error)}`,
        {
          error: errorMessage(error),
          last: this.lastDiagnostics,
        },
      );
    }
    if (!isValidUsage(reply.usage)) {
      throw this.end(
        "model_failed",
        "The model reported no usable token usage, so the ceiling cannot be held.",
        null,
      );
    }
    await recordAcquireJobTokens(
      this.ctx,
      this.scope,
      this.job.id,
      reply.usage,
      this.deps.acquireJob,
    );
    this.tokensSpent += reply.usage.inputTokens + reply.usage.outputTokens;
    if (this.open) {
      this.open.usage = {
        inputTokens: this.open.usage.inputTokens + reply.usage.inputTokens,
        outputTokens: this.open.usage.outputTokens + reply.usage.outputTokens,
      };
    }
    const answer = reply.answer;
    const said = answer.kind === "give_up" ? answer.reason : answer.note;
    await this.trace("model", `${situation.kind} → ${answer.kind}: ${said}`, {
      attempt: this.open?.number ?? null,
      data: {
        situation: situation.kind,
        answer: answer.kind,
        usage: reply.usage,
        tokensSpent: this.tokensSpent,
      },
    });
    if (this.tokensSpent > this.config.tokenCeiling) {
      await this.closeOpen(this.openOutcome(), "the token ceiling was reached");
      throw this.end(
        "token_ceiling",
        `The token ceiling of ${this.config.tokenCeiling} was reached after ${this.tokensSpent} tokens; the last diagnostics are in lastDiagnostics.`,
        this.lastDiagnostics,
      );
    }
    if (!answerAllowed(situation.kind, answer.kind)) {
      throw this.end(
        "model_failed",
        `The model answered ${situation.kind} with ${answer.kind}, which that situation does not admit.`,
        { situation: situation.kind, answer: answer.kind },
      );
    }
    return answer;
  }

  private async readDocs(urls: readonly string[]): Promise<DocPage[]> {
    const pages: DocPage[] = [];
    for (const url of urls.slice(0, MAX_DOCS_PER_TURN)) {
      const page = await this.deps.readWebPage({ url });
      if (page.ok) {
        pages.push({
          url: page.url,
          ok: true,
          title: page.title,
          content: page.content,
          truncated: page.truncated,
        });
        await this.trace(
          "docs",
          `Read ${page.url}${page.title ? ` (${page.title})` : ""}: ${page.totalCharacters} characters${page.truncated ? ", first window" : ""}.`,
          { data: { url: page.url, title: page.title, totalCharacters: page.totalCharacters } },
        );
      } else {
        pages.push({ url, ok: false, error: page.error });
        await this.trace("docs", `Could not read ${url}: ${page.error}`, {
          data: { url, error: page.error },
        });
      }
    }
    if (urls.length > MAX_DOCS_PER_TURN) {
      await this.trace(
        "docs",
        `${urls.length - MAX_DOCS_PER_TURN} more page(s) were asked for than one turn reads (${MAX_DOCS_PER_TURN}).`,
      );
    }
    return pages;
  }

  private async openAttempt(draft: ModuleDraft, note: string): Promise<OpenAttempt> {
    const row = await startAcquireAttempt(
      this.ctx,
      this.scope,
      this.job.id,
      {
        draftPath: (n) => attemptDraftPath(this.job.id, n),
        files: draft.files,
        diagnosis: note,
        redaction: this.redaction,
      },
      this.deps.acquireJob,
    );
    this.attemptsMade = row.attemptNumber;
    const attempt: OpenAttempt = {
      row,
      number: row.attemptNumber,
      draft,
      usage: { inputTokens: 0, outputTokens: 0 },
      proofFailed: false,
    };
    this.open = attempt;
    await this.trace(
      "edit",
      `Attempt ${attempt.number}: drafted ${draft.name} — ${draft.files.map((f) => f.path).join(", ")} — at ${row.draftPath}.`,
      {
        attempt: attempt.number,
        data: {
          name: draft.name,
          files: draft.files.map((f) => f.path),
          proofReads: draft.proofReads,
        },
      },
    );
    const handle = await this.sandbox();
    await handle.writeTree(draft.files, sandboxPath(row.draftPath));
    return attempt;
  }

  /** The check; null when it accepts, else the situation the model is shown. */
  private async check(attempt: OpenAttempt): Promise<ModelSituation | null> {
    const sources = readModuleSources(attempt.draft.files as ModuleFile[]);
    const checked = await this.deps.checkModule({
      files: sources.files,
      entry: sources.entry,
      inputSchema: attempt.draft.inputSchema,
      dependencies: sources.dependencies,
    });
    const output = {
      entry: checked.entry,
      refusals: checked.refusals,
      advice: checked.advice,
      annotations: checked.annotations,
    };
    if (checked.refusals.length === 0) {
      await this.trace(
        "check",
        `Check passed attempt ${attempt.number}: read-only ${checked.annotations.readOnly}, destructive ${checked.annotations.destructive}${checked.advice.length ? `, ${checked.advice.length} piece(s) of advice` : ""}.`,
        { attempt: attempt.number, data: output },
      );
      return null;
    }
    await this.trace(
      "check",
      `Check refused attempt ${attempt.number}: ${checked.refusals.map((r) => `${r.rule} at ${r.file}:${r.line}`).join("; ")}.`,
      { attempt: attempt.number, data: output },
    );
    await this.progress(
      `Attempt ${attempt.number}: the check refused the module (${checked.refusals.map((r) => r.rule).join(", ")}); asking the model to fix it.`,
    );
    this.lastDiagnostics = { check: output };
    await this.closeOpen("check_refused", null, output);
    return {
      kind: "check_refused",
      attempt: attempt.number,
      refusals: checked.refusals.map(toModelDiagnostic),
      advice: checked.advice.map(toModelDiagnostic),
    };
  }

  /** The proof reads, each through the execute path with the dry-run claim on. */
  private async prove(attempt: OpenAttempt, connection: ProofConnection): Promise<ProofRead[]> {
    const connectionId = connection.id;
    const handle = await this.sandbox();
    if (!this.probeWritten) {
      await handle.writeTree(
        [{ path: "index.mjs", content: PROBE_MODULE }],
        sandboxPath(probePath(this.job.id)),
      );
      this.probeWritten = true;
    }
    const reads: ProofRead[] = [];
    const mode = { detached: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS, dryRun: true };
    for (const path of attempt.draft.proofReads.slice(0, MAX_PROOF_READS)) {
      const outcome = await runWithCapability({
        deps: this.deps,
        scope: this.scope,
        connectionId,
        claim: EXECUTE_CLAIM,
        mode,
        run: (env) => {
          if (env.GRAFT_TOKEN) this.redaction.secretValues.push(env.GRAFT_TOKEN);
          return runModule(handle, {
            scope: this.scope,
            modulePath: sandboxPath(probePath(this.job.id)),
            input: { path },
            env,
            mode,
          });
        },
      });
      const read = describeProofRead(path, outcome, connection);
      reads.push(read);
      if (read.ok) {
        await this.trace("proof", `Proof read GET ${path}: ${read.status}.`, {
          attempt: attempt.number,
          data: { path, status: read.status, body: read.body },
        });
      } else {
        attempt.proofFailed = true;
        await this.trace(
          "vendor_error",
          `Proof read GET ${path} failed: ${read.status ?? "no status"} ${read.error ?? read.body ?? ""}`.trim(),
          {
            attempt: attempt.number,
            data: {
              path,
              status: read.status,
              body: read.body,
              error: read.error,
              redirectTo: read.redirectTo,
            },
          },
        );
      }
    }
    this.lastDiagnostics = { proofReads: reads };
    await this.progress(
      attempt.proofFailed
        ? `Attempt ${attempt.number}: ${reads.filter((r) => !r.ok).length} of ${reads.length} proof read(s) failed; asking the model what to change.`
        : `Attempt ${attempt.number}: ${reads.length} proof read(s) answered as the documentation said.`,
    );
    return reads;
  }

  private async publishAndDryRun(
    attempt: OpenAttempt,
    connectionId: string,
    vendor: string,
  ): Promise<{ success: AcquireSuccess } | { situation: ModelSituation }> {
    const publish = this.deps.publishTool;
    if (!publish) {
      throw this.end(
        "job_failed",
        "This deployment has no toolbox store, so nothing can be published.",
        null,
      );
    }
    const { draft } = attempt;
    const wire = authoredToolName(vendor, draft.name);
    let outcome: PublishOutcome;
    try {
      outcome = await publish({
        personId: this.scope.personId,
        agentId: this.scope.agentId,
        jobId: this.job.id,
        toolboxId: toolboxIdOf(this.scope.personId),
        vendor,
        name: draft.name,
        description: draft.description,
        inputSchema: draft.inputSchema,
        draftPath: attempt.row.draftPath,
        defaultConnectionId: connectionId,
      });
    } catch (error) {
      // A bad name or description is the publish's refusal before it reads anything; the model
      // fixes the definition as it would a diagnostic.
      if (!(error instanceof ServiceError) || error.code !== "BAD_REQUEST") throw error;
      outcome = {
        ok: false,
        refusals: [
          {
            rule: "definition-invalid" as never,
            file: "index.ts",
            line: 1,
            column: 1,
            text: "",
            message: error.message,
            hint: "Fix the tool's name, description or input schema and draft again.",
          },
        ],
        advice: [],
        annotations: { readOnly: false, destructive: true },
      };
    }
    if (!outcome.ok) {
      const output = {
        refusals: outcome.refusals,
        advice: outcome.advice,
        annotations: outcome.annotations,
      };
      await this.trace(
        "publish",
        `Publish refused attempt ${attempt.number} as ${wire}: ${outcome.refusals.map((r) => `${r.rule}: ${r.message}`).join("; ")}`,
        { attempt: attempt.number, data: output },
      );
      await this.progress(
        `Attempt ${attempt.number}: the publish refused ${wire} (${outcome.refusals.map((r) => r.rule).join(", ")}); asking the model to fix it.`,
      );
      this.lastDiagnostics = { publish: output };
      await this.closeOpen("publish_refused", null, output);
      return {
        situation: {
          kind: "publish_refused",
          attempt: attempt.number,
          refusals: outcome.refusals.map(toModelDiagnostic),
          advice: outcome.advice.map(toModelDiagnostic),
        },
      };
    }

    const version = outcome.version;
    await this.trace(
      "publish",
      `Published ${wire} v${version.versionNumber} from attempt ${attempt.number} (read-only ${outcome.annotations.readOnly}, destructive ${outcome.annotations.destructive}${outcome.dependencies.length ? `; packages: ${outcome.dependencies.join(", ")}` : ""}).`,
      {
        attempt: attempt.number,
        data: {
          toolId: outcome.tool.id,
          versionId: version.id,
          version: version.versionNumber,
          annotations: outcome.annotations,
          dependencies: outcome.dependencies,
        },
      },
    );
    await this.progress(
      `Attempt ${attempt.number}: published ${wire} v${version.versionNumber}; dry-running it with the test input.`,
    );

    const dry = await runAuthoredTool(this.deps, this.scope, {
      vendor,
      name: draft.name,
      input: draft.testInput,
      mode: { detached: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS, dryRun: true },
      channel: NO_ELICITATION,
    });
    const report = dry.isError
      ? null
      : readDryRunReport((dry.answer as { dryRun?: unknown }).dryRun);
    if (!report) {
      const failure = dry.isError ? dry.answer : { error: "The run produced no dry-run report." };
      const line = typeof failure.error === "string" ? failure.error : JSON.stringify(failure);
      await this.trace(
        "dry_run",
        `Dry run of ${wire} v${version.versionNumber} did not run: ${line}`,
        {
          attempt: attempt.number,
          data: { versionId: version.id, failure },
        },
      );
      await this.progress(
        `Attempt ${attempt.number}: the dry run of ${wire} did not run (${line}); asking the model what to change.`,
      );
      this.lastDiagnostics = { dryRun: null, failure };
      await this.closeOpen("run_failed", null, undefined, version.id);
      return {
        situation: { kind: "dry_run_failed", attempt: attempt.number, report: null, failure: line },
      };
    }

    const summary = summariseDryRun(report);
    await this.trace(
      "dry_run",
      `Dry run of ${wire} v${version.versionNumber} ${report.passed ? "passed" : "failed"}: ${report.reads.length} read(s), ${report.writesPreviewed.length} write(s) previewed, ${report.writesRefused.length} refused${report.moduleError ? `; module error: ${report.moduleError}` : ""}.`,
      {
        attempt: attempt.number,
        data: { versionId: version.id, report: report as unknown as Record<string, unknown> },
      },
    );
    if (
      report.moduleError &&
      (report.reads as { status?: number }[]).some((r) => (r.status ?? 0) >= 400)
    ) {
      await this.trace("vendor_error", report.moduleError, {
        attempt: attempt.number,
        data: { reads: report.reads as unknown[] },
      });
    }
    if (!report.passed) {
      await this.progress(
        `Attempt ${attempt.number}: the dry run of ${wire} v${version.versionNumber} failed; asking the model to diagnose and fix it.`,
      );
      this.lastDiagnostics = { dryRun: summary };
      await this.closeOpen("dry_run_failed", null, undefined, version.id);
      return {
        situation: {
          kind: "dry_run_failed",
          attempt: attempt.number,
          report: summary,
          failure: null,
        },
      };
    }

    await this.closeOpen("passed", null, undefined, version.id);
    const promoted = await promotePublished(
      this.ctx,
      this.scope,
      outcome.tool.id,
      this.deps,
      this.deps.notifier,
    );
    await this.progress(
      `Attempt ${attempt.number}: the dry run passed. ${wire} v${version.versionNumber} is ${promoted.changed ? "promoted into your working set" : "already in your working set"}; its first real use is yours to make${outcome.annotations.readOnly ? "" : ", and the person is asked once before it"}.`,
    );
    return {
      success: {
        tool: wire,
        toolId: outcome.tool.id,
        version: version.versionNumber,
        annotations: {
          readOnlyHint: outcome.annotations.readOnly,
          destructiveHint: outcome.annotations.destructive,
        },
      },
    };
  }

  /**
   * What an attempt the loop leaves mid-way is closed as: `proof_failed` when a proof read had
   * already failed — that is what stopped it, whatever the model said next — else `abandoned`.
   */
  private openOutcome(): "proof_failed" | "abandoned" {
    return this.open?.proofFailed ? "proof_failed" : "abandoned";
  }

  /** Close the open attempt, if any, and add it to what was tried. */
  private async closeOpen(
    outcome: Exclude<AcquireAttemptOutcome, "running">,
    diagnosis: string | null,
    checkOutput?: Record<string, unknown>,
    versionId?: string,
  ): Promise<void> {
    const attempt = this.open;
    if (!attempt) return;
    this.open = null;
    await finishAcquireAttempt(
      this.ctx,
      this.scope,
      attempt.row.id,
      {
        outcome,
        usage: attempt.usage,
        redaction: this.redaction,
        ...(checkOutput === undefined ? {} : { checkOutput }),
        ...(versionId === undefined ? {} : { versionId }),
        ...(diagnosis === null ? {} : { diagnosis }),
      },
      this.deps.acquireJob,
    );
    this.tried.push({
      attempt: attempt.number,
      outcome,
      summary: diagnosis ?? attempt.row.diagnosis ?? `${attempt.draft.name}: ${outcome}`,
    });
  }

  /** A resumed job's attempt rows still marked running belong to a process that died. */
  private async abandonStaleAttempts(): Promise<void> {
    const attempts = await listAcquireAttempts(
      this.ctx,
      this.scope,
      this.job.id,
      this.deps.acquireJob,
    );
    for (const row of attempts) {
      if (row.outcome === "running") {
        await finishAcquireAttempt(
          this.ctx,
          this.scope,
          row.id,
          {
            outcome: "abandoned",
            diagnosis: "The process running this attempt stopped; the job resumed from the goal.",
          },
          this.deps.acquireJob,
        );
      }
      this.tried.push({
        attempt: row.attemptNumber,
        outcome: row.outcome === "running" ? "abandoned" : row.outcome,
        summary: row.diagnosis ?? row.outcome,
      });
    }
  }

  private async sandbox(): Promise<SandboxHandle> {
    if (this.handle) return this.handle;
    try {
      this.handle = await openAgentSandbox(this.deps, this.scope);
    } catch (error) {
      throw this.end("sandbox_unavailable", `The sandbox is unavailable: ${errorMessage(error)}`, {
        error: errorMessage(error),
      });
    }
    return this.handle;
  }

  private async progress(line: string): Promise<void> {
    await appendAcquireJobProgress(this.ctx, this.scope, this.job.id, [line], this.deps.acquireJob);
    await this.trace("progress", line);
  }

  private async trace(
    kind: AcquireTraceKind,
    text: string,
    extra: { attempt?: number | null; data?: Record<string, unknown> } = {},
  ): Promise<void> {
    await appendAcquireTrace(
      this.ctx,
      this.scope,
      this.job.id,
      {
        kind,
        text,
        attemptNumber: extra.attempt === undefined ? (this.open?.number ?? null) : extra.attempt,
        data: extra.data ?? null,
        redaction: this.redaction,
      },
      this.deps.acquireJob,
    );
  }

  /**
   * The result is redacted here because it is the one text of the job's that no repo redacts on
   * the way in: `completeAcquireJob` stores it as given, and the runner's finished event and the
   * server's log line carry its message. A provider's error body can echo a credential
   * (`errorMessage` keeps its sentence, GRA-60), so the same rule the traces get applies.
   */
  private failure(
    kind: AcquireFailureKind,
    message: string,
    lastDiagnostics: unknown,
  ): AcquireFailure {
    return redactValue<AcquireFailure>(
      {
        failure: kind,
        message,
        lastDiagnostics: lastDiagnostics ?? this.lastDiagnostics ?? null,
        tried: [...this.tried],
      },
      this.redaction,
    ).value;
  }

  private end(kind: AcquireFailureKind, message: string, lastDiagnostics: unknown): JobEnded {
    return new JobEnded(this.failure(kind, message, lastDiagnostics));
  }
}

function toModelDiagnostic(diagnostic: {
  rule: string;
  file: string;
  line: number;
  column: number;
  message: string;
  hint: string;
}): ModelDiagnostic {
  const { rule, file, line, column, message, hint } = diagnostic;
  return { rule, file, line, column, message, hint };
}

/** A proof read's outcome in the model's terms: the probe's answer, or why there was none. */
/** What a proof read needs to know of the connection: its id for the run, its hosts for a redirect. */
type ProofConnection = { id: string; primaryHost: string; hosts: readonly string[] };

function describeProofRead(path: string, outcome: unknown, connection: ProofConnection): ProofRead {
  if (
    typeof outcome === "object" &&
    outcome !== null &&
    "error" in outcome &&
    (outcome as { error?: unknown }).error === "refused"
  ) {
    const refusal = outcome as { reason?: string; message?: string };
    return {
      path,
      ok: false,
      status: null,
      body: null,
      error: `${refusal.reason ?? "refused"}: ${refusal.message ?? ""}`.trim(),
      redirectTo: null,
    };
  }
  const run = outcome as {
    ok: boolean;
    result?: unknown;
    failure?: { error: string; stderrTail: string };
  };
  if (!run.ok) {
    const failure = run.failure;
    return {
      path,
      ok: false,
      status: null,
      body: null,
      error: failure
        ? `${failure.error}${failure.stderrTail ? ` — ${failure.stderrTail}` : ""}`
        : "the run failed",
      redirectTo: null,
    };
  }
  const report = readDryRunReport(run.result);
  const probe = (report?.moduleResult ?? null) as {
    status?: number;
    ok?: boolean;
    body?: string;
    location?: string | null;
  } | null;
  if (report?.moduleError) {
    return {
      path,
      ok: false,
      status: null,
      body: null,
      error: report.moduleError,
      redirectTo: null,
    };
  }
  if (!probe || typeof probe.status !== "number") {
    return {
      path,
      ok: false,
      status: null,
      body: null,
      error: "The probe returned no answer.",
      redirectTo: null,
    };
  }
  const body = typeof probe.body === "string" ? probe.body : null;
  if (isRedirect(probe.status)) {
    const redirect = describeRedirect(path, probe.location ?? null, connection);
    return {
      path,
      ok: false,
      status: probe.status,
      body,
      error: redirect.error,
      redirectTo: redirect.host,
    };
  }
  return {
    path,
    ok: probe.status < 400,
    status: probe.status,
    body,
    error: null,
    redirectTo: null,
  };
}

/**
 * A redirected proof read, in the connection's terms. The proxy returned the 3xx unfollowed and the
 * runner did not follow it (CONTEXT.md *Proxy*; GRA-64), so the read is a fact about the host set:
 * a host the connection declares is the module's to call through `ctx.proxyBase(host)`; one it does
 * not is nobody's inside this job — consent never moves inside the loop (ADR 0004, ADR 0006) — so
 * the model is told to give up naming it, and the person connects it (GRA-65).
 */
function describeRedirect(
  path: string,
  location: string | null,
  connection: ProofConnection,
): { host: string | null; error: string } {
  if (!location) {
    return {
      host: null,
      error: `The vendor redirected GET ${path} without saying where (no Location header).`,
    };
  }
  // Resolved against the URL the read went to — the primary host's base path plus the proof path,
  // as the proxy builds it (`resolveTarget`) — so a relative `Location` lands where the vendor meant.
  let target: URL;
  try {
    const base = new URL(connection.primaryHost);
    const [pathname = "", search] = path.split("?", 2);
    const request = new URL(base.href);
    request.pathname = `${base.pathname.replace(/\/+$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    request.search = search ? `?${search}` : "";
    target = new URL(location, request);
  } catch {
    return {
      host: null,
      error: `The vendor redirected GET ${path} to an unreadable Location: ${location.slice(0, 200)}`,
    };
  }
  // The host as the proxy judges it — its own normalised set, an entry with or without a port
  // (`hostSetOf`) — so this sentence and the proxy's `host_not_in_set` agree.
  const declared = hostSetOf({ primaryHost: connection.primaryHost, hosts: connection.hosts });
  const host = declared.has(target.host) ? target.host : target.hostname;
  const where = `${target.pathname}${target.search}`;
  if (declared.has(host)) {
    return {
      host,
      error:
        `The vendor redirected GET ${path} to ${host}${where}, a host this connection declares. ` +
        `The proxy does not follow redirects, so the module must call that host itself: ctx.proxyBase("${host}") is its base, and ${where} is the path the vendor wants there.`,
    };
  }
  return {
    host,
    error:
      `The vendor redirected GET ${path} to ${host}${where}, which this connection does not declare ` +
      `(it declares ${[...declared].join(", ")}). ` +
      `Nothing in this job can add a host. Answer give_up with a reason that names ${host}, so the person can connect the vendor with that host in its set and the tool can be built against it.`,
  };
}

function summariseDryRun(report: DryRunReport): DryRunSummary {
  return {
    passed: report.passed,
    reads: report.reads as DryRunSummary["reads"],
    writesPreviewed: report.writesPreviewed,
    writesRefused: report.writesRefused,
    moduleError: report.moduleError ?? null,
    moduleResult: report.moduleResult ?? null,
    unverified: report.unverified,
  };
}
