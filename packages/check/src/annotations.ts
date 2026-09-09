/**
 * What the tool's MCP annotations will say, derived from the module's calls (ADR 0008): `readOnly`
 * when every call the check can see is a `GET` or `HEAD` through `ctx.fetch`; `destructive` when any
 * is a `DELETE`. Any other method, a method the check cannot read, and every call into an SDK count as
 * writes. Meaningful when `refusals` is empty; a module the check could not read at all reports
 * `UNKNOWN_ANNOTATIONS`.
 *
 * Its own file, imported by the core (with its `.ts` extension, for the worker's native resolution)
 * and by the door, because the door may import no value from the core: that would load the compiler
 * on the main thread, which is what the worker exists to avoid (`module-check.ts`).
 */
export type ToolAnnotations = { readOnly: boolean; destructive: boolean };

/** What is said of a module nothing could be read from: it asks, and it asks every time. */
export const UNKNOWN_ANNOTATIONS: ToolAnnotations = { readOnly: false, destructive: true };
