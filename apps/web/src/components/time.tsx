import { formatDateTime, formatRelative } from "@/lib/format";

/** A moment, relative when recent, with the exact time a hover away; nothing for a value that is not one. */
export function Time({ iso, className }: { iso: string; className?: string }) {
  const relative = formatRelative(iso);
  if (!relative) return null;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {relative}
    </time>
  );
}
