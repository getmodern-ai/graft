import { Link } from "@tanstack/react-router";

import { ExploreIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * What an address that matches no route renders. Without one the router falls back to a bare
 * unstyled "Not Found" — no link out, nothing that says which application this is.
 *
 * The same shape and voice as `RouteError`, which is Cando's (`apps/web/src/components/
 * route-not-found.tsx`): `Empty` with an icon, a sentence-case title carrying no full stop, one
 * sentence of description whose clause after the em dash is reassurance rather than instruction,
 * and the escape as a real `Link` so the router handles it rather than the browser reloading the
 * bundle.
 *
 * One action, not two. `RouteError` offers "Try again" first because a failed fetch is worth
 * retrying; re-requesting an address that does not exist gets the same answer, so a retry here
 * would be a button that promises something it cannot do. It goes to `/agents` by name — the
 * console's home is the agents list (`routes/index.tsx`).
 */
export function RouteNotFound() {
  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ExploreIcon />
        </EmptyMedia>
        <EmptyTitle>This page does not exist</EmptyTitle>
        <EmptyDescription>
          The address may be mistyped, or out of date — everything else is where you left it.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex gap-2">
        {/* `nativeButton={false}` because this renders an anchor. Base UI assumes a native
            <button> otherwise and logs an error. */}
        <Button nativeButton={false} render={<Link to="/agents" />}>
          Go to agents
        </Button>
      </div>
    </Empty>
  );
}
