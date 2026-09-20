import { createFileRoute, redirect } from "@tanstack/react-router";

/** Agent details are deferred (GRA-135); existing links return to the table. */
export const Route = createFileRoute("/_auth/_shell/agents/$agentId")({
  beforeLoad: () => {
    throw redirect({ to: "/agents", replace: true });
  },
});
