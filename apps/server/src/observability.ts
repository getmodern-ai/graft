import type { Backings } from "./backings";

/**
 * What the process does with its three observability seams (GRA-100; ADR 0002 as amended
 * 2026-09-19): reads the backings the selector answered — a log drain, an analytics backing, a
 * model telemetry backing, each null or `off` in the open form — into the two things `index.ts`
 * needs of them beside the objects themselves: one clause per seam for the boot line, and one
 * bounded flush for the way out.
 *
 * Nothing here names a vendor. The open form's answer is "no drain, analytics off, model telemetry
 * off", under which the server is exactly what it was before this file: wide events on stdout,
 * which is the container's log, and nothing else leaving the process. The hosted form's backings
 * come from the private package, and Cando's shape for what they do — a vendor's drain behind
 * evlog's pipeline, a vendor's analytics client, a tracing vendor's span processor, each off until
 * its variables arrive (Cando's CAN-460) — lives there now, not here.
 */

export type ObservabilityBackings = Pick<Backings, "logDrain" | "analytics" | "modelTelemetry">;

/** Three clauses for the boot line: `logs …`, `analytics …`, `model telemetry …`. */
export function describeObservability(backings: ObservabilityBackings): string {
  return (
    `logs ${backings.logDrain ? `stdout and ${backings.logDrain.name}` : "stdout"}, ` +
    `analytics ${backings.analytics.name}, ` +
    `model telemetry ${backings.modelTelemetry?.name ?? "off"}`
  );
}

/**
 * Deliver what the three have buffered and close them, bounded: a stop is ECS's `SIGTERM` with
 * thirty seconds before `SIGKILL`, and an ingest endpoint that is down should cost a few of those,
 * not all of them. The telemetry backing is flushed and then shut down — a span processor's
 * exporter holds a connection the flush alone does not close. Rejections are settled, never thrown
 * — a flush is best effort.
 */
export function flushObservability(
  backings: ObservabilityBackings,
  withinMs: number,
): Promise<void> {
  const telemetry = backings.modelTelemetry;
  const work = Promise.allSettled([
    backings.logDrain?.flush(),
    backings.analytics.shutdown(),
    telemetry ? telemetry.flush().finally(() => telemetry.shutdown()) : undefined,
  ]).then(() => undefined);
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, withinMs).unref();
  });
  return Promise.race([work, deadline]);
}
