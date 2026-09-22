import type { Scenario } from "./scenarios";
import type { ScenarioRun, Score } from "./scorers";

/**
 * The report. Printed rather than asserted, because the first job of the suite is to say what the
 * model does today. **The headline is the weakest score, not a mean** (Cando's CAN-105): a scenario's
 * scorers are a conjunction, so a scenario passes only when every one of them does, and the overall
 * line is how many scenarios passed whole.
 */

/** A run's attempts and tokens, its chained stage's included (GRA-191). */
export function chainTotals(run: ScenarioRun): { attempts: number; tokens: number } {
  const rest = run.next ? chainTotals(run.next) : { attempts: 0, tokens: 0 };
  return {
    attempts: run.status.attempts + rest.attempts,
    tokens: run.tokens.total + rest.tokens,
  };
}

export type ScenarioReport = {
  scenario: Scenario;
  run: ScenarioRun | null;
  /** Set when the run threw before it could be scored. */
  error?: string;
  scores: Score[];
};

export function renderScorecard(
  reports: readonly ScenarioReport[],
  options: { model: string },
): string {
  const rule = "─".repeat(78);
  const lines: string[] = ["", rule, `  GRAFT ACQUIRE EVALUATION — model: ${options.model}`, rule];
  let passed = 0;
  let total = 0;

  for (const { scenario, run, error, scores } of reports) {
    const whole = error === undefined && scores.length > 0 && scores.every((s) => s.pass);
    if (whole) passed += 1;
    const totals = run ? chainTotals(run) : null;
    total += totals?.tokens ?? 0;
    const failing = scores.filter((s) => !s.pass).length;
    lines.push(
      "",
      `  ${whole ? "PASS" : "FAIL"}  ${scenario.name}` +
        (run && totals
          ? `   (${totals.attempts} attempt(s), ${totals.tokens} tokens, ${Math.round(run.ms / 1000)}s)`
          : "") +
        (failing ? `   ${failing} scorer(s) red` : ""),
      `        ${scenario.because}`,
    );
    if (error) lines.push(`        ERROR  ${error.slice(0, 300)}`);
    for (const score of scores) {
      lines.push(
        `        ${score.pass ? "ok  " : "RED "} ${score.name.padEnd(40)}${score.detail ? ` ${score.detail.slice(0, 200)}` : ""}`,
      );
    }
    if (run?.status.progress.length) {
      lines.push(`        progress: ${run.status.progress.at(-1)?.slice(0, 160)}`);
    }
    if (run?.next?.status.progress.length) {
      lines.push(`        progress: ${run.next.status.progress.at(-1)?.slice(0, 160)}`);
    }
  }

  lines.push(
    "",
    rule,
    `  OVERALL  ${passed}/${reports.length} scenario(s) passed whole   tokens: ${total} in total across every model turn`,
    rule,
    "",
  );
  return lines.join("\n");
}
