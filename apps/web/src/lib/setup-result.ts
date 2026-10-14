import { canRun, initialValues, type RunInputView, runInputOf } from "./setup-run-input";

/**
 * The result step's pure half (GRA-215): which tool it may show and run on arrival.
 * `GET /api/setup/tool` is cached, and the record's tool changes when the person goes back,
 * chooses another integration and builds again, so a cached context can still name the tool an
 * earlier job published (Greptile on #170). The step shows and runs the context's tool only once
 * it is the one the record names; until then it waits for the context to be read again.
 */
export function resultToolOf<T extends { id: string }>(
  recordToolId: string | null | undefined,
  tool: T | null | undefined,
): T | null {
  if (!tool || !recordToolId) return null;
  return tool.id === recordToolId ? tool : null;
}

/**
 * Whether the step runs the tool on arrival, before the person presses anything: a read-only tool
 * whose form, as drawn, already holds everything the run needs: no input at all, or every
 * required field at a starting value (the starter's `runInput`, the schema's `default` or its
 * first `examples` entry) and every value in its field's type. The ready-made
 * `gmail__search-messages`, both fields optional and prefilled, waited behind *Not run yet* on the
 * production walk of 2026-10-14; Open-Meteo's prefilled city now runs too, and the person runs it
 * again for another. A required field nothing fills, or a JSON input, whose skeleton is only a
 * placeholder, waits for Run. A tool that is not read-only never runs unasked: the run route
 * refuses it anyway (`tool_not_read_only`).
 */
export function runsOnArrival(view: RunInputView, tool: { readOnly: boolean }): boolean {
  if (!tool.readOnly) return false;
  if (view.kind === "none") return true;
  if (view.kind !== "form") return false;
  const values = initialValues(view);
  return canRun(view, values, "") && runInputOf(view, values).ok;
}
