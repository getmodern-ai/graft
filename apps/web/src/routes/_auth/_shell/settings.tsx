import { createFileRoute } from "@tanstack/react-router";

import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { ModelKeySettings } from "@/components/settings/model-key-settings";
import { useScreenTitle } from "@/components/shell/screen-title";
import { modelKeyQuery } from "@/lib/model-key-queries";

/**
 * The person's settings — one section today, the model key (ADR 0014), in Cando's settings row
 * family (GRA-47). Anything a person sets about themselves rather than about an agent or a
 * connection goes here, as another `SettingsSection` under the same header.
 *
 * The header stays where Cando's settings shell puts its section title, in the page, because the
 * console has one settings screen and no settings sidebar to carry the navigation instead.
 */
export const Route = createFileRoute("/_auth/_shell/settings")({
  loader: ({ context }) => context.queryClient.ensureQueryData(modelKeyQuery),
  component: SettingsRoute,
});

function SettingsRoute() {
  useScreenTitle("Settings");

  return (
    // `gap-6`: a header over one region, and the 24px Cando's settings column puts between sections.
    <PageContainer size="medium" className="gap-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Settings</PageHeaderTitle>
          <PageHeaderDescription>
            What is yours across every agent: the model your acquire jobs run on.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <ModelKeySettings />
    </PageContainer>
  );
}
