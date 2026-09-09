import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { ModelKeyCard } from "@/components/settings/model-key-card";
import { modelKeyQuery } from "@/lib/model-key-queries";

/**
 * The person's settings — one card today, the model key (ADR 0014), and the smallest screen that
 * fits the shell for it. Anything a person sets about themselves rather than about an agent or a
 * connection goes here.
 */
export const Route = createFileRoute("/_auth/_shell/settings")({
  loader: ({ context }) => context.queryClient.ensureQueryData(modelKeyQuery),
  component: SettingsRoute,
});

function SettingsRoute() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="What is yours across every agent: the model your acquire jobs run on."
      />
      <ModelKeyCard />
    </>
  );
}
