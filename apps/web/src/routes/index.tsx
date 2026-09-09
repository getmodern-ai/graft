import { createFileRoute, redirect } from "@tanstack/react-router";

import { DEFAULT_SIGNED_IN_PATH } from "@/lib/safe-redirect";

/** The console has no home of its own; the agents are what a person comes for (ADR 0007). */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ href: DEFAULT_SIGNED_IN_PATH });
  },
});
