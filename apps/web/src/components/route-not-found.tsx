import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** An address that matches no route. One action: re-requesting a missing address gets the same answer. */
export function RouteNotFound() {
  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CompassIcon />
        </EmptyMedia>
        <EmptyTitle>This page does not exist</EmptyTitle>
        <EmptyDescription>
          The address may be mistyped, or out of date — everything else is where you left it.
        </EmptyDescription>
      </EmptyHeader>
      <Button nativeButton={false} render={<Link to="/agents" />}>
        Go to agents
      </Button>
    </Empty>
  );
}
