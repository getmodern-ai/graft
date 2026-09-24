/**
 * The model adapter — the seam between `acquire`'s job and whatever answers as Graft's model
 * (ADR 0004: Graft holds the pen; ADR 0002: one interface, two backings). The **job owns the loop
 * and the tools**: it reads the documentation, writes the draft, runs the check, makes the proof
 * reads, publishes and dry-runs. The model only **answers**, one situation at a time, and every
 * answer reports what it cost, so the job can hold the token ceiling (ADR 0014: attempts are
 * bounded by count and by tokens).
 *
 * What the model is never handed: a credential, the capability token, or a way to call the vendor
 * itself. Reads happen through the connection's execute path with the dry-run claim on, and their
 * results come back here as text (`ProofRead`). A page of documentation comes back as text too
 * (`DocPage`) and is untrusted, which the authoring skill the model is handed says in its own words.
 *
 * Two backings: `./scripted.ts` here, a list of canned answers for the suite and for a laptop with no
 * provider; the provider-backed one is GRA-31's and runs `./conformance.ts` to prove it answers the
 * same questions. This package imports nothing, so the types are what both sides compile against.
 */

/** What the job tells the model about the connection it is authoring against. Never a credential. */
export type ConnectionBrief = {
  id: string;
  vendor: string;
  displayName: string;
  /** The auth scheme's name, so the model knows what the proxy injects; the values are the proxy's. */
  scheme: string;
  /** The base URL vendor-relative paths resolve against. */
  primaryHost: string;
  /** Every host the connection may reach — what `ctx.proxyBase(host)` may name. */
  hosts: readonly string[];
};

/** Handed once, at `open`; the situations that follow refer back to it. */
export type ModelJobContext = {
  jobId: string;
  /**
   * Whose job this is — the person the requesting agent belongs to (ADR 0007). The routed adapter
   * (`./routed.ts`) picks the person's own provider key over the deployment's fixed model by it
   * (ADR 0014), and every provider call carries it as a trace attribute (`./telemetry.ts`). An id
   * for routing and for the trace, never an authenticated principal: nothing downstream of the
   * model may treat it as a right.
   */
  personId: string;
  goal: string;
  hints: string | null;
  connection: ConnectionBrief;
  /** The authoring skill's text (`packages/runner/skills/authoring-a-tool/SKILL.md`), the discipline the model follows. */
  skill: string;
  /** The bounds the job holds the model to, so a provider-backed model can pace itself. */
  budget: { maxAttempts: number; tokenCeiling: number };
};

/** What one answer cost. Whole tokens; the job sums them against the ceiling. */
export type ModelUsage = { inputTokens: number; outputTokens: number };

export type ModuleFile = { path: string; content: string };

/**
 * A module as the model drafts it: what the publish takes, plus the test input the dry run needs
 * and the reads that prove the credential and the request shape before anything is published
 * (the skill's step 4). `proofReads` are vendor-relative `GET` paths, `/items?limit=1`; the job
 * runs each through the connection's execute path with the dry-run claim on and hands the answers
 * back as `ProofRead`s. Empty skips the step.
 */
export type ModuleDraft = {
  /** Kebab-case; with the vendor, the tool's identity. */
  name: string;
  description: string;
  /** A JSON Schema object (`type: "object"`); `Input` is generated from it at the check. */
  inputSchema: Record<string, unknown>;
  /** `index.ts` and any siblings; a `package.json` when the module declares a package (ADR 0013). */
  files: ModuleFile[];
  testInput: Record<string, unknown>;
  proofReads: string[];
};

/** A diagnostic as the check and the publish report one — `@graft/check`'s `Diagnostic`, structurally. */
export type ModelDiagnostic = {
  rule: string;
  file: string;
  line: number;
  column: number;
  message: string;
  hint: string;
};

/** A documentation page the job read for the model, or why it could not. Untrusted text. */
export type DocPage =
  | { url: string; ok: true; title: string | null; content: string; truncated: boolean }
  | { url: string; ok: false; error: string };

/** One proof read's answer: the vendor's status and the head of its body, credentials redacted. */
export type ProofRead = {
  path: string;
  ok: boolean;
  status: number | null;
  body: string | null;
  /** Why the read produced no answer at all — the run failed, the proxy refused. */
  error: string | null;
  /**
   * The host a 3xx pointed at, when the vendor redirected the read; null otherwise. The proxy hands
   * a redirect back unfollowed and the runner does not follow it either (GRA-64), so a redirect is
   * a fact about the connection's host set, not about the code — `error` says which (GRA-65).
   */
  redirectTo: string | null;
  /**
   * The proxy's reason when it refused the read for want of a vendor response — `upstream_unreachable`,
   * `upstream_timeout`, `host_not_public`, off its `x-graft-refusal` header (GRA-79); null when the
   * vendor answered, whatever it answered. The job ends on it before the read is shown, so this is
   * the wire's record rather than the model's cue.
   */
  reason: string | null;
};

/** The dry-run report as the model reads it — `runner.mjs`'s report, the parts a diagnosis turns on. */
export type DryRunSummary = {
  passed: boolean;
  /**
   * A read the proxy refused for want of a vendor response carries `reason`, and the `code` and
   * `host` the proxy named (GRA-79; the runner's record); a read the vendor answered has the three
   * fields alone.
   */
  reads: {
    method: string;
    path: string;
    status: number;
    reason?: string;
    code?: string | null;
    host?: string | null;
  }[];
  writesPreviewed: unknown[];
  writesRefused: unknown[];
  moduleError: string | null;
  moduleResult: unknown;
  unverified: string[];
};

/**
 * What the job puts to the model. `goal` opens the conversation; every other kind is the outcome of
 * something the job did with the model's last answer. `attempt` numbers the draft the outcome is
 * about, as the console shows it.
 */
export type ModelSituation =
  | { kind: "goal" }
  | { kind: "docs"; pages: DocPage[] }
  | {
      kind: "check_refused";
      attempt: number;
      refusals: ModelDiagnostic[];
      advice: ModelDiagnostic[];
    }
  /**
   * Every proof read the draft asked for, passed or failed. `proceed` publishes only when every
   * read passed; a `proceed` over a failed read is refused once and the situation shown again with
   * `refused` saying so (GRA-72), null on the first showing.
   */
  | { kind: "proof"; attempt: number; reads: ProofRead[]; refused: string | null }
  | {
      kind: "publish_refused";
      attempt: number;
      refusals: ModelDiagnostic[];
      advice: ModelDiagnostic[];
    }
  /** `report` is null when the run produced none — the runner failed — and `failure` says how. */
  | {
      kind: "dry_run_failed";
      attempt: number;
      report: DryRunSummary | null;
      failure: string | null;
    };

export type ModelSituationKind = ModelSituation["kind"];

/**
 * What the model may answer. `note` is one line the job records as the attempt's diagnosis and
 * relays as progress — what the model learned, what it changed. `write_module` always starts a new
 * attempt; `prove` adds reads to the current attempt without a new draft (GRA-153: a path built
 * from what the first read returned, a record's id, is proven without spending an attempt);
 * `proceed` is only meaningful after a `proof` situation whose reads all passed; `give_up` ends
 * the job.
 */
export type ModelAnswer =
  | { kind: "read_docs"; urls: string[]; note: string }
  | { kind: "write_module"; draft: ModuleDraft; note: string }
  | { kind: "prove"; proofReads: string[]; note: string }
  | { kind: "proceed"; note: string }
  | { kind: "give_up"; reason: string };

export type ModelAnswerKind = ModelAnswer["kind"];

export type ModelReply = { answer: ModelAnswer; usage: ModelUsage };

/** One job's conversation. A provider-backed adapter keeps its message history here. */
export type ModelConversation = {
  turn(situation: ModelSituation): Promise<ModelReply>;
};

export type ModelAdapter = {
  /** Which backing this is — `scripted`, or the provider's name — for the trace. */
  readonly name: string;
  open(context: ModelJobContext): ModelConversation;
  /**
   * Setup's goal suggestions (GRA-209): up to three short read-only goals for a vendor the person
   * just connected, from the triage model. Optional, so an adapter that cannot propose (a test's
   * stand-in) answers none by being without it; the provider's, the scripted one and the router
   * all carry it. It answers rather than throws for want of goals: a refusal, a timeout or an
   * unusable answer is an empty `goals` with the `outcome` saying which.
   */
  proposeGoals?(request: GoalProposalRequest): Promise<GoalProposal>;
};

/**
 * What a goal proposal is about: the vendor as the person connected it, and the starter's curated
 * goal when the vendor is a starter one (`@graft/core`'s `setup/starter-vendors.ts`). Never a
 * credential.
 */
export type GoalProposalRequest = {
  /** Whose proposal this is; the router picks the person's own key by it (ADR 0014), as a job's `personId`. */
  personId: string;
  /** What the call serves, for the trace where a job's id would go (`setup:<personId>`). */
  traceId: string;
  vendor: string;
  displayName: string;
  primaryHost: string;
  docsUrl: string | null;
  curatedGoal: string | null;
};

/**
 * How a proposal ended. `proposed` carries goals; every other outcome carries none: the model
 * answered an empty list (`declined`), answered out of shape or with nothing usable (`unusable`),
 * ran past its bound (`timeout`), the call failed (`failed`), or no model answers this person
 * (`unavailable`).
 */
export type GoalProposalOutcome =
  | "proposed"
  | "declined"
  | "unusable"
  | "timeout"
  | "failed"
  | "unavailable";

export type GoalProposal = {
  goals: string[];
  outcome: GoalProposalOutcome;
  usage: ModelUsage;
  /** The failure's message, for the log, when `outcome` is `failed`. */
  error?: string;
};

/** Which answers a situation admits; the job refuses the others as a model failure, by name. */
export const ANSWERS_FOR: Record<ModelSituationKind, readonly ModelAnswerKind[]> = {
  goal: ["read_docs", "write_module", "give_up"],
  docs: ["read_docs", "write_module", "give_up"],
  check_refused: ["read_docs", "write_module", "give_up"],
  proof: ["read_docs", "write_module", "prove", "proceed", "give_up"],
  publish_refused: ["read_docs", "write_module", "give_up"],
  dry_run_failed: ["read_docs", "write_module", "give_up"],
};

export function answerAllowed(situation: ModelSituationKind, answer: ModelAnswerKind): boolean {
  return ANSWERS_FOR[situation].includes(answer);
}

/** Whole, non-negative tokens — what a usage figure must be for the ceiling to mean anything. */
export function isValidUsage(usage: unknown): usage is ModelUsage {
  if (typeof usage !== "object" || usage === null) return false;
  const { inputTokens, outputTokens } = usage as Record<string, unknown>;
  return [inputTokens, outputTokens].every(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
  );
}
