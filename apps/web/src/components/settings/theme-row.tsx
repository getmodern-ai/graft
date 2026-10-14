import { useId } from "react";

import { SettingsRow } from "@/components/settings/settings-row";
import { useTheme } from "@/components/theme-provider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { THEME_OPTIONS, themeChoiceOf } from "@/lib/account-settings";

/**
 * Settings › Appearance › Theme (GRA-331; Figma 2100:10414): System, Light or Dark as a segmented
 * control, through the same `next-themes` setting the account menu's radio group writes, so the
 * two never disagree. The segments are `ToggleGroup` (Cando's primitive) drawn as the frame's
 * track: a muted, bordered rail with the chosen segment raised on the card surface.
 *
 * A toggle group may be emptied by pressing the pressed item; a theme cannot be none, so an empty
 * change is ignored and the choice stands.
 */
export function ThemeRow() {
  const { theme, setTheme } = useTheme();
  const titleId = useId();
  const choice = themeChoiceOf(theme);

  return (
    <SettingsRow
      stacked
      title={<span id={titleId}>Theme</span>}
      description="Match your computer, or pick one."
      action={
        <ToggleGroup
          aria-labelledby={titleId}
          size="sm"
          spacing={0.5}
          value={[choice]}
          onValueChange={(next: string[]) => {
            const picked = next[0];
            if (picked) setTheme(themeChoiceOf(picked));
          }}
          className="rounded-lg border border-border bg-muted/50 p-0.5"
        >
          {THEME_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="rounded-md border border-transparent px-2.5 font-normal text-muted-foreground text-sm hover:bg-transparent aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    />
  );
}
