import type { ModelTelemetry } from "@graft/model";

/**
 * The model telemetry seam's backing shape (GRA-100; ADR 0002 as amended 2026-09-19). The seam
 * itself is `@graft/model`'s `ModelTelemetry` — the integrations a call names and the wrapper that
 * carries the trace's attributes down to every span — and `NO_TELEMETRY` there is the open form's
 * whole backing: under it a model call is exactly what it would be untraced. The hosted form's
 * backing, a tracing vendor's, lives in the private package and is answered as
 * `Backings.modelTelemetry`; this is what it hands over — the telemetry, and the flush the server
 * calls on the way out so the last job's spans are not lost.
 */
export type ModelTelemetryBacking = {
  /** The name the boot line carries — the vendor's. */
  name: string;
  telemetry: ModelTelemetry;
  /** Export everything buffered. Call before the process exits. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};
