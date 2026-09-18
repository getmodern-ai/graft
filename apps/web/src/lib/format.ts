/**
 * How the console prints a moment. Every timestamp on the wire is an ISO string (`api.ts`,
 * `Jsonified`), so these take strings and never a `Date` a caller had to remember to construct.
 *
 * Both are total: a value that is not a date — an empty string where a nullable column was
 * coalesced, garbage — prints as nothing rather than throwing. `Intl.DateTimeFormat.format` throws
 * `RangeError: Invalid time value` on an Invalid Date, and one such throw inside a card took the
 * whole Connections route to its boundary (GRA-96); a screen is never taken down by one field.
 */

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** The moment `iso` names, or null when it names none. */
function momentOf(iso: string): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(iso: string): string {
  const moment = momentOf(iso);
  return moment ? dateTime.format(moment) : "";
}

/** "3 minutes ago", "yesterday", "in 2 days" — for a moment near now; `formatDateTime` for the rest. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const moment = momentOf(iso);
  if (!moment) return "";
  const seconds = Math.round((moment.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return formatDateTime(iso);
}

/** A whole number with the noun, singular or plural: "1 day", "21 days". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
