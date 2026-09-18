import type { Telemetry } from "ai";

import type { ModelSituationKind } from "./types";

/**
 * The observability seam the provider-backed adapter calls through, so the adapter knows nothing
 * of any tracing vendor and a test can stand a recorder in its place. Two halves, because the AI SDK (v7)
 * traces in two ways: `integrations` are the callback objects a call names in
 * `telemetry.integrations`, notified as the call starts, steps and ends; `traced` wraps the call
 * so the trace-level attributes — session, user, tags, metadata — travel down by async context to
 * every span the SDK starts inside it. The one real binding is the hosted form's, in the private
 * package behind `Backings.modelTelemetry` (ADR 0002 as amended 2026-09-19); `NO_TELEMETRY` is the
 * open form's whole backing and what every unit test runs with, and under it a call is exactly
 * what it would be without this file.
 */

/** Which of the two models answered: the strong one that writes code, the cheap one that never does. */
export type ModelRole = "authoring" | "triage";

/** What one provider call is about — every field a trace carries, decided before the call. */
export type ModelCallTrace = {
  role: ModelRole;
  jobId: string;
  personId: string;
  /** The attempt the call is about: the situation's own number, or the draft about to be written. */
  attempt: number;
  situation: ModelSituationKind;
  provider: string;
  modelId: string;
};

export type ModelTelemetry = {
  /** Spread into each call's `telemetry.integrations`; empty means the SDK call names none. */
  readonly integrations: readonly Telemetry[];
  /** Run `fn` under the trace's attributes; identity when nothing is listening. */
  traced<T>(trace: ModelCallTrace, fn: () => Promise<T>): Promise<T>;
};

export const NO_TELEMETRY: ModelTelemetry = {
  integrations: [],
  traced: (_trace, fn) => fn(),
};
