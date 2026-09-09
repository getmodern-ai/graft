import { formatDateTime, formatRelative } from "@/lib/format";

/** A moment, relative when recent, with the exact time a hover away. */
export function Time({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  );
}
