import { createFileRoute } from "@tanstack/react-router";

import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { ModelKeyCard } from "@/components/settings/model-key-card";
import { useScreenTitle } from "@/components/shell/screen-title";
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
  useScreenTitle("Settings");

  return (
    <PageContainer size="medium" className="gap-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Settings</PageHeaderTitle>
          <PageHeaderDescription>
            What is yours across every agent: the model your acquire jobs run on.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <ModelKeyCard />
    </PageContainer>
  );
}
