import type { RunInputView } from "./setup-run-input";

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
 * Whether the step runs the tool on arrival, before the person presses anything: only a tool that
 * takes no input (Greptile on #172). A tool with inputs shows its fields, prefilled where there is
 * a starting value (Open-Meteo's Melbourne), and waits for Run, so the first answer is for what
 * the person chose and never for a default they did not pick.
 */
export function runsOnArrival(view: RunInputView): boolean {
  return view.kind === "none";
}
