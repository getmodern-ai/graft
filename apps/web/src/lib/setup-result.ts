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
