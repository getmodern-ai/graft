import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";

import { RefreshIcon, WarningIcon, WifiOffIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { isOfflineError } from "@/lib/network-error";

/**
 * What a route renders when its loader or component throws. Without one the router falls back to
 * a bare "Something went wrong!" with no way out but a reload.
 *
 * Cando's `apps/web/src/components/route-error.tsx`: the offline case gets its own glyph, title
 * and advice, because the advice differs — a network problem is worth retrying, an application
 * error usually is not. `lib/network-error.ts` is the check, shared with the `RetryNotice` a
 * table body shows for the same failure.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const offline = isOfflineError(error);
  // `error` is `unknown` on the router's props; `ApiError` extends `Error`, so one check covers
  // the server's own sentence and anything else that was thrown with a message.
  const message =
    error instanceof Error && error.message ? error.message : "An unexpected error occurred.";

  /**
   * `invalidate` before `reset`, in that order, or the page blanks: `reset` clears the boundary
   * and re-renders the route immediately, `invalidate` re-runs the loader. Resetting first means
   * the component renders while its loader data is still absent, so it throws — inside the
   * boundary that was meant to contain the failure, which React then unmounts entirely.
   */
  const retry = async () => {
    await router.invalidate();
    reset();
  };

  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">{offline ? <WifiOffIcon /> : <WarningIcon />}</EmptyMedia>
        <EmptyTitle>{offline ? "Could not reach the server" : "Something went wrong"}</EmptyTitle>
        <EmptyDescription>
          {offline ? "Check your connection and try again — nothing has been lost." : message}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex gap-2">
        <Button onClick={retry}>
          <RefreshIcon />
          Try again
        </Button>
        {/* `nativeButton={false}` because this renders an anchor. Base UI assumes a native
            <button> otherwise and logs an error — especially unhelpful from the one component
            whose job is to render when something has already gone wrong. */}
        <Button variant="outline" nativeButton={false} render={<Link to="/agents" />}>
          Go to agents
        </Button>
      </div>
    </Empty>
  );
}
