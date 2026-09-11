import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { isOfflineError, OFFLINE_ERROR_MESSAGE } from "@/lib/network-error";

/**
 * Inline text plus a working Retry, for a read whose failure is the screen — a table body, a
 * settings panel — rather than a background refresh of something still on it.
 *
 * The global toast (`lib/query-error-retry.ts`) already answers every failed query with a Retry
 * action, but a toast is gone in four seconds and the screen is left where it was; this is the
 * durable copy of the same action. `message` is the caller's copy for an ordinary failure; a
 * request that never reached the server overrides it with the sentence `RouteError` shows for the
 * same reason, because the advice does not depend on which read failed. `retrying` is the
 * caller's `isFetching`, which disables the button while a retry is in flight without hiding it,
 * and returns to `false` whether the retry succeeded or failed — so a second failure lands on a
 * working Retry, never a stuck spinner.
 *
 * Cando's `apps/web/src/components/retry-notice.tsx` (its CAN-257), with the import rewrites.
 */
export function RetryNotice({
  error,
  message,
  onRetry,
  retrying,
}: {
  error: unknown;
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const text = isOfflineError(error) ? OFFLINE_ERROR_MESSAGE : message;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {text}
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshIcon className={retrying ? "animate-spin" : undefined} />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </span>
  );
}
