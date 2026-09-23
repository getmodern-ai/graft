/**
 * What a `jsonb` column cannot hold (GRA-201). Postgres stores jsonb as parsed values, and a JSON
 * string may not contain U+0000 there: the insert is refused with SQLSTATE 22P05, "unsupported
 * Unicode escape sequence". A proof read of a binary endpoint put a NUL into a trace row's payload on
 * 2026-09-23 and the job died on the write. The loop writes five jsonb columns from text it did not
 * author — a vendor's body, a module's files, the check's diagnostics, the model's notes —
 * `acquire_job.progress` and `.result`, `acquire_attempt.files` and `.check_output`,
 * `acquire_trace.data` — so every string in each, keys included, passes through here in the service
 * that writes it, and the write is total whatever arrived.
 */

/** The one character jsonb refuses inside a string. */
const NUL = "\u0000";

/**
 * The value with U+0000 removed from every string in it: values and keys, nested arrays and objects.
 * A key the cleaning would land on another key's name keeps its entry under a numbered name
 * (`a (2)`), so two fields that differed only by a NUL both survive; the untouched keys are placed
 * first, so which one is renamed does not depend on their order.
 */
export function withoutNul<T>(value: T): T {
  const clean = (text: string): string => (text.includes(NUL) ? text.replaceAll(NUL, "") : text);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return clean(node);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const entries = Object.entries(node as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of entries) {
        if (!key.includes(NUL)) out[key] = walk(entry);
      }
      for (const [key, entry] of entries) {
        if (!key.includes(NUL)) continue;
        const base = clean(key);
        let name = base;
        for (let n = 2; name in out; n += 1) name = `${base} (${n})`;
        out[name] = walk(entry);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
