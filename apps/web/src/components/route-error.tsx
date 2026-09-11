import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { RefreshIcon, WarningIcon } from "@/components/icons";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ApiError } from "@/lib/api";

/**
 * What a route renders when its loader or component throws. Without one the router falls back to
 * a bare "Something went wrong!" with no way out but a reload.
 *
 * `invalidate` before `reset`, in that order: resetting first re-renders the route while its loader
 * data is still absent, so it throws again inside the boundary meant to contain it.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const retry = async () => {
    await router.invalidate();
    reset();
  };
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof TypeError
        ? "Check your connection and try again — nothing has been lost."
        : error instanceof Error && error.message
          ? error.message
          : "An unexpected error occurred.";

  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WarningIcon />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <div className="flex gap-2">
        <Button onClick={retry}>
          <RefreshIcon />
          Try again
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link to="/agents" />}>
          Go to agents
        </Button>
      </div>
    </Empty>
  );
}
