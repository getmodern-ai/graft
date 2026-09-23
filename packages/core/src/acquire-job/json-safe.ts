/**
 * What a `jsonb` column cannot hold (GRA-201). Postgres stores jsonb as parsed values, and a JSON
 * string may not contain U+0000 there: the insert is refused with SQLSTATE 22P05, "unsupported
 * Unicode escape sequence". A proof read of a binary endpoint put a NUL into a trace row's payload on
 * 2026-09-23 and the job died on the write. `acquire_trace.data` and `acquire_job.result` are the
 * two columns the loop writes from text it did not author — a vendor's body, a module's error — so
 * every string in either passes through here first, and the write is total whatever arrived.
 */

/** The one character jsonb refuses inside a string. */
const NUL = "\u0000";

/** The value with U+0000 removed from every string in it, nested arrays and objects included. */
export function withoutNul<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.includes(NUL) ? node.replaceAll(NUL, "") : node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return node;
  };
  return walk(value) as T;
}
