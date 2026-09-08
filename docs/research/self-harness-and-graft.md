# Self-Harness, and where Graft sits in it

"Self-Harness: Harnesses That Improve Themselves", arXiv 2606.09498. Hangfan Zhang, Shao Zhang,
Kangcong Li, Chen Zhang, Yang Chen, Yiqun Zhang, Lei Bai, Shuyue Hu, Shanghai Artificial
Intelligence Laboratory. v1 8 June 2026, v2 12 August 2026, v3 20 August 2026 (cs.CL). Code:
<https://github.com/qzzqzzb/Self-Harness>. Read from <https://arxiv.org/abs/2606.09498> and
<https://arxiv.org/html/2606.09498v3>. Graft terms follow `CONTEXT.md`.

## What the paper says

**A harness.** Section 3.1: "A harness includes the instructions, the available tools, memory and
state-management mechanisms, etc. The harness does not modify the model parameters; instead, it
specifies the execution protocol through which the model observes a task, takes actions, invokes
tools, checks intermediate artifacts, and produces a final answer."

**Nine editable surfaces** (Figure 3, the initial harness): system prompt; memory sources;
subagents; skills; bootstrap instruction; execution instruction; verification instruction; failure
recovery instruction; runtime control policy.

**The loop** (Algorithm 1), run by one fixed model that is also the agent under improvement:

1. **Weakness mining** (3.2). Run the current harness on the held-in tasks, cluster failed traces
   by verifier-grounded failure signature, and build an evidence bundle of the dominant failure
   patterns without prescribing edits.
2. **Harness proposal** (3.3). The same model, as proposer, generates K mutually distinct
   candidate edits, each tied to one failure mechanism and one surface, "constrained to modify
   only the surface needed ... preserve unrelated harness behavior, and avoid broad rewrites of the
   agent control architecture". The default proposal width is K = 1.
3. **Proposal validation** (3.4). Each candidate is evaluated on held-in and held-out splits and
   accepted only if it regresses neither and improves at least one: delta_in >= 0, delta_ho >= 0,
   max(delta_in, delta_ho) > 0. Accepted edits merge into the next harness.

**Results** (Table 1, overall pass rate, initial harness to final harness; relative gain computed
from those two columns). Splits: Terminal-Bench-2.0 a fixed 64-case subset (held-in and held-out
counts not stated); SWE-bench Verified 100 tasks, 67 held-in and 33 held-out; AppWorld 180 tasks,
90 and 90.

| Benchmark | MiniMax M2.5 | Qwen3.5-35B-A3B | GLM-5 |
| --- | --- | --- | --- |
| Terminal-Bench-2.0 | 42.2 to 53.9 (+28%) | 18.0 to 36.7 (+104%) | 46.1 to 57.0 (+24%) |
| SWE-bench Verified | 46.0 to 52.5 (+14%) | 19.5 to 41.5 (+113%) | 52.0 to 55.5 (+7%) |
| AppWorld | 48.6 to 58.9 (+21%) | 22.5 to 52.2 (+132%) | 44.4 to 85.0 (+91%) |

Every model-benchmark pair improved; the abstract's headline is "relative gains of up to 132%",
Qwen3.5-35B-A3B on AppWorld.

**Edits it found.** Terminal-Bench: a bootstrap instruction to create artifacts early, a runtime
policy capping total tool messages, dependency pre-checks, loop-breaking and retry discipline, a
tool-error redirect toward the missing artifact, shell environment persisting across commands.
SWE-bench: subagents separating empty-diff detection from targeted testing, a patch-inspection
subagent with pre-submission tests, dependency repair inside verification. AppWorld: a
state-auditor subagent with pagination and temporal boundaries, completion-contract guards
separating action tasks from information requests, exhaustive pagination before any mutation.

**Limitations** (Section 5, quoted): "It studies bounded harness edits under fixed benchmarks,
not open-ended self-improvement. Accepted edits may still reflect benchmark-specific failure
patterns, and the protocol depends on the quality of verifier outcomes and trace records.
Higher-stakes harness changes would require stronger acceptance gates than pass-rate
non-regression alone." The paper does not state how many rounds were run or what they cost.

## Where Graft sits

Graft's product is a durable, model-authored extension of one of the nine surfaces, the tools. An
authored tool that `acquire` publishes and promotes into an agent's working set is what the
paper's loop would produce for that surface, except that Graft edits the harness from outside,
over MCP. ADR 0012 maps the paper's stages onto Graft in five levels:

- **L0, static check and dry run.** At publish: the check, a test input, a dry run in which reads
  reach the vendor and writes stop at the proxy, the outcome stored per version. A verifier, the
  paper's precondition, not one of its stages. At launch.
- **L1, candidates inside `acquire`.** When a dry run fails, `acquire` diagnoses and retries with
  a changed module several times inside one job: the proposal stage with K > 1 in sequence rather
  than in parallel, validated by the dry run rather than held-out tasks. At launch.
- **L2, repair from failure rate.** A published tool that used to pass and starts failing triggers
  `acquire` against the failing trace and a republish: validation feeding proposal for one tool,
  over the per-tool, per-agent ledger ADR 0009 also reads. First feature after launch; a repaired
  read-only tool keeps its approval, a repaired write tool asks once more (ADR 0008).
- **L3, mining across customers.** Failed authoring runs are clustered by cause across every
  customer, edits to Graft's own authoring skill, prompts and checker rules are proposed, and an
  edit is accepted only if the eval suite does not regress. This is where the paper's weakness
  mining lives, run over **Graft's authoring harness, never the customer's**. Internal,
  human-gated, weekly from the first week; a recurring issue with an owner, never a feature.
- **L4, the outer agent's skills and instructions.** The paper's other eight surfaces, as they
  exist in OpenClaw or Hermes. Never; Hermes already creates skills from experience.

Stated plainly: at launch Graft implements the paper's **outcome**, a durable, verified,
model-authored change to a harness's tool surface, and only the **proposal-and-validation half** of
its loop (L1's retries, L0's dry run as the gate). The mining stage arrives with L3 and points at
Graft, not at the person's harness. ADR 0004 makes it reachable: the authoring traces sit in
Graft's process. ADR 0012 names what must be recorded from day one: every inner-loop trace, every
redacted vendor error body, every dry-run report, and the outcome ledger.

One caveat carries over. The paper's gate is pass-rate non-regression on benchmark splits; L3's
is an eval suite over authoring scenarios, the same shape with the same weakness, edits that fit
the suite rather than the world. The paper's closing requirement, self-improvement "grounded in
behavioral evidence rather than only in the proposer's rationale", is the standard L3 must meet.

## The prior finding on Cando

A peer session on 2026-09-03 compared the paper with Cando's authored-tools mechanism, the code
Graft is copied from (ADR 0011). Its judgment, in the memory note
`self-harness-paper-vs-authored-tools.md`: Cando shares the paper's outcome but none of its three
stages. No weakness mining; one candidate rather than K; static checks plus a dry run in place of
a held-in and held-out regression gate; no rollback or history surface. The session's phrase for
it, as relayed in the brief for this document, was "Self-Harness run by hand"; the note records the
gaps but not that wording. ADR 0012's levels answer the gaps: L1 restores K, L2 and L3 add mining,
and the toolbox keeps every version (`CONTEXT.md`, "Toolbox").

## The companion paper

"LLM-as-Code: Agentic Programming for Agent Harness", arXiv 2606.15874 (Qi et al., v1 14 June
2026, v2 22 June 2026, KDD 2026 AgenticSE workshop) argues the program should own all control flow
with the model a component inside it. Its fourth pillar, "self-programmed evolution" (Section
3.4), is the closest published description of what `acquire` produces: "the result is committed as
code (accepted only once it passes the caller's tests) and thereafter runs like any other
guaranteed step." An authored tool is that committed code, the dry run standing where the caller's
tests stand. Self-Harness does not cite LLM-as-Code; the pairing is ours.
