import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { EmailRow, NameRow, SocialAccountRows } from "@/components/settings/account-rows";
import { ModelKeySettings } from "@/components/settings/model-key-settings";
import { PasswordRow } from "@/components/settings/password-row";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import { SettingsSection } from "@/components/settings/settings-section";
import { ThemeRow } from "@/components/settings/theme-row";
import { useScreenTitle } from "@/components/shell/screen-title";
import { linkOutcome, readSettingsSearch } from "@/lib/account-settings";
import { modelKeyQuery, modelQuery } from "@/lib/model-key-queries";

/**
 * The person's settings (GRA-331; Figma 2100:10414): Account (how they sign in), Appearance (the
 * theme), Building tools (the model and their own key, ADR 0014), in Cando's settings row family
 * (GRA-47). Anything a person sets about themselves rather than about an agent or a connection goes
 * here, as another `SettingsSection`; another way of signing in is another row in Account's group.
 * Delete account is GRA-307's and waits for it.
 *
 * The search is a provider link's return (`account-settings.ts`'s `linkSocialUrls`): the page says
 * how it went once, then drops the query so a reload says nothing.
 *
 * The header stays where Cando's settings shell puts its section title, in the page, because the
 * console has one settings screen and no settings sidebar to carry the navigation instead.
 */
export const Route = createFileRoute("/_auth/_shell/settings")({
  validateSearch: readSettingsSearch,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(modelKeyQuery),
      context.queryClient.ensureQueryData(modelQuery),
    ]),
  component: SettingsRoute,
});

function SettingsRoute() {
  useScreenTitle("Settings");
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    const outcome = linkOutcome(search);
    if (!outcome) return;
    // One id, so a second run of the effect replaces the toast rather than stacking one.
    if (outcome.kind === "success") toast.success(outcome.message, { id: "settings-link" });
    else toast.error(outcome.message, { id: "settings-link" });
    void navigate({ to: "/settings", search: {}, replace: true });
  }, [search, navigate]);

  return (
    // `gap-8` under the header and `gap-10` between sections: App v2's settings column.
    <PageContainer size="medium" className="gap-8">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Settings</PageHeaderTitle>
          <PageHeaderDescription>
            What's yours across every agent and integration.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <div className="flex flex-col gap-10">
        <SettingsSection heading="Account" description="How you sign in to Graft.">
          <SettingsCard>
            <SettingsRowGroup>
              <NameRow />
              <EmailRow />
              <SocialAccountRows />
              <PasswordRow />
            </SettingsRowGroup>
          </SettingsCard>
        </SettingsSection>
        <SettingsSection heading="Appearance">
          <SettingsCard>
            <SettingsRowGroup>
              <ThemeRow />
            </SettingsRowGroup>
          </SettingsCard>
        </SettingsSection>
        <ModelKeySettings />
      </div>
    </PageContainer>
  );
}
