import type { ReactNode } from "react";

import { SettingsCard, SettingsCardContent } from "@/components/settings/settings-card";
import { SettingsEmptyRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";

/** Cando Figma 404:601149: heading outside the card, 12px gap, 16px by 12px row insets. */
export function AgentDetailsSection({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsSection
      heading={title}
      description={description}
      className="shrink-0"
      headingClassName="flex items-center gap-2 text-base leading-6"
    >
      <SettingsCard className="border-border">
        <SettingsCardContent className="@container flex flex-col gap-4 px-4 py-3">
          {children}
        </SettingsCardContent>
        {actions ? (
          <SettingsEmptyRow className="justify-end gap-2 border-t">{actions}</SettingsEmptyRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
