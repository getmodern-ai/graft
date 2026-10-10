import type { SetupHarness } from "@graft/core/setup/harness";

import githubLogo from "@/assets/setup/app-github.png";
import gmailLogo from "@/assets/setup/app-gmail.png";
import googleCalendarLogo from "@/assets/setup/app-google-calendar.png";
import googleDriveLogo from "@/assets/setup/app-google-drive.png";
import hubspotLogo from "@/assets/setup/app-hubspot.png";
import notionLogo from "@/assets/setup/app-notion.png";
import slackLogo from "@/assets/setup/app-slack.png";
import chatgptMark from "@/assets/setup/harness-chatgpt.svg";
import claudeMark from "@/assets/setup/harness-claude.svg";
import hermesMark from "@/assets/setup/harness-hermes.svg";
import openclawMark from "@/assets/setup/harness-openclaw.svg";
import { ExtensionIcon, LanguageIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * The marks Setup v2 draws beside a starter integration and a harness. The integrations' are the
 * Figma file's own exports (the "Console / Setup v2" frames' app cards and logo wall); the
 * harnesses' are the marketing site's (`public/figma/`), since the Figma file's harness logos do
 * not export. Flat files under `src/assets`, outside the colour guard on purpose, as the sign-in
 * provider marks are. A starter or harness with no mark draws a Material glyph instead.
 */
const STARTER_LOGOS: Record<string, string> = {
  gmail: gmailLogo,
  "google-calendar": googleCalendarLogo,
  "google-drive": googleDriveLogo,
  slack: slackLogo,
  notion: notionLogo,
  github: githubLogo,
  hubspot: hubspotLogo,
};

const HARNESS_MARKS: Partial<Record<SetupHarness, string>> = {
  claude: claudeMark,
  "claude-code": claudeMark,
  chatgpt: chatgptMark,
  codex: chatgptMark,
  hermes: hermesMark,
  openclaw: openclawMark,
};

/** A mark in the frames' 40px icon tile (`secondary` band, the small radius), or bare at `size`. */
export function SetupLogo({
  starterId,
  harness,
  url,
  tile = true,
  className,
}: {
  starterId?: string | null;
  harness?: SetupHarness | null;
  /** A directory entry's own mark (`logoUrl`), used where no bundled mark exists for it. */
  url?: string | null;
  tile?: boolean;
  className?: string;
}) {
  const bundled = starterId
    ? STARTER_LOGOS[starterId]
    : harness
      ? HARNESS_MARKS[harness]
      : undefined;
  const src = bundled ?? url ?? undefined;
  const Fallback = starterId || url !== undefined ? LanguageIcon : ExtensionIcon;
  const mark = src ? (
    <img alt="" src={src} className={cn("object-contain", tile ? "size-5" : className)} />
  ) : (
    <Fallback className={cn("text-muted-foreground", tile ? "size-5" : className)} />
  );
  if (!tile) return mark;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary",
        className,
      )}
    >
      {mark}
    </span>
  );
}
