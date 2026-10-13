import { useState } from "react";

import githubLogo from "@/assets/marks/app-github.png";
import gmailLogo from "@/assets/marks/app-gmail.png";
import googleCalendarLogo from "@/assets/marks/app-google-calendar.png";
import googleDriveLogo from "@/assets/marks/app-google-drive.png";
import hubspotLogo from "@/assets/marks/app-hubspot.png";
import notionLogo from "@/assets/marks/app-notion.png";
import slackLogo from "@/assets/marks/app-slack.png";
import claudeMark from "@/assets/marks/harness-claude.svg";
import cursorMark from "@/assets/marks/harness-cursor.svg";
import hermesMark from "@/assets/marks/harness-hermes.svg";
import openaiMark from "@/assets/marks/harness-openai.svg";
import openclawMark from "@/assets/marks/harness-openclaw.svg";
import { ExtensionIcon } from "@/components/icons";
import { type HarnessMarkId, integrationMarkKey, markInitials } from "@/lib/marks";
import { cn } from "@/lib/utils";

/**
 * The integration and harness marks every screen draws (GRA-288). The integrations' are the Figma
 * file's own exports ("Graft / App logo"); the harnesses' are the marketing site's, which the
 * file's "Graft / Harness logo" reuses: Claude Code draws Claude's and Codex OpenAI's, as the file
 * does, and Cursor's is Simple Icons' (CC0), since the file has none. Flat files under
 * `src/assets/marks`, outside the colour guard on purpose, as the sign-in provider marks are; a
 * one-colour mark inverts in dark mode, as GitHub's does on the sign-in card. Brand artwork keeps
 * its own colours, so none of this is a token.
 */
const INTEGRATION_LOGOS: Record<string, string> = {
  gmail: gmailLogo,
  "google-calendar": googleCalendarLogo,
  "google-drive": googleDriveLogo,
  slack: slackLogo,
  notion: notionLogo,
  github: githubLogo,
  hubspot: hubspotLogo,
};

const HARNESS_ART: Record<Exclude<HarnessMarkId, "generic">, { src: string; mono?: true }> = {
  claude: { src: claudeMark },
  "claude-code": { src: claudeMark },
  chatgpt: { src: openaiMark, mono: true },
  codex: { src: openaiMark, mono: true },
  cursor: { src: cursorMark, mono: true },
  hermes: { src: hermesMark },
  openclaw: { src: openclawMark },
};

/** The frames' tiles: `secondary` (the agent card, Setup) or `outline` (rows, the install grid). */
export type MarkTile = "secondary" | "outline" | "none";
export type MarkTileSize = 32 | 36 | 40;
export type MarkSize = 16 | 18 | 20 | 22;

const TILE_SIZE: Record<MarkTileSize, string> = { 32: "size-8", 36: "size-9", 40: "size-10" };
const MARK_SIZE: Record<MarkSize, string> = {
  16: "size-4",
  18: "size-[18px]",
  20: "size-5",
  22: "size-[22px]",
};
const TILE_VARIANT: Record<Exclude<MarkTile, "none">, string> = {
  secondary: "bg-secondary",
  outline: "border border-border bg-card",
};

type Sizing = {
  /** `none` draws the mark bare, sized by `className`. */
  tile?: MarkTile;
  tileSize?: MarkTileSize;
  /** The mark inside a tile. */
  size?: MarkSize;
  /** On the tile, or on the bare mark when `tile` is `none`. */
  className?: string;
};

function Framed({
  tile = "secondary",
  tileSize = 40,
  size = 20,
  className,
  children,
}: Sizing & { children: (markClass: string) => React.ReactNode }) {
  if (tile === "none") return <>{children(cn("shrink-0", className))}</>;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        TILE_SIZE[tileSize],
        TILE_VARIANT[tile],
        className,
      )}
    >
      {children(cn("shrink-0", MARK_SIZE[size]))}
    </span>
  );
}

/** Letters scaled to the box they sit in, for an integration with no artwork. */
function Initials({ text, className }: { text: string; className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("@container flex items-center justify-center", className)}
    >
      <span className="font-medium text-[45cqw] text-muted-foreground leading-none">{text}</span>
    </span>
  );
}

/**
 * An integration's mark: the directory's `logoUrl` when the hosted form answers one, then the
 * bundled file for its vendor slug, then its initials. A logo that fails to load steps down to
 * the next.
 */
export function IntegrationMark({
  slug,
  name,
  logoUrl,
  ...sizing
}: Sizing & {
  /** The vendor slug or a starter's id; either finds the bundled file. */
  slug?: string | null;
  /** For the initials; the slug's parts stand in without it. */
  name?: string | null;
  logoUrl?: string | null;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const bundled = slug ? INTEGRATION_LOGOS[integrationMarkKey(slug)] : undefined;
  const src = [logoUrl, bundled].find(
    (candidate): candidate is string => !!candidate && !failed.includes(candidate),
  );
  return (
    <Framed {...sizing}>
      {(markClass) =>
        src ? (
          <img
            alt=""
            src={src}
            onError={() => setFailed((list) => [...list, src])}
            className={cn("object-contain", markClass)}
          />
        ) : (
          <Initials text={markInitials(name, slug)} className={markClass} />
        )
      }
    </Framed>
  );
}

/** A harness's mark (`lib/marks.ts`'s `harnessMark` picks it); `generic` is the extension glyph. */
export function HarnessMark({ mark, ...sizing }: Sizing & { mark: HarnessMarkId }) {
  const art = mark === "generic" ? null : HARNESS_ART[mark];
  return (
    <Framed {...sizing}>
      {(markClass) =>
        art ? (
          <img
            alt=""
            src={art.src}
            className={cn("object-contain", art.mono && "dark:invert", markClass)}
          />
        ) : (
          <ExtensionIcon className={cn("text-muted-foreground", markClass)} />
        )
      }
    </Framed>
  );
}

/**
 * The request row's pair: the integration in a 36px outlined tile, the harness asking for it on a
 * round 22px badge over its bottom right corner, 44px in all ("Logos" in the Requests frame).
 */
export function IntegrationHarnessMark({
  slug,
  name,
  logoUrl,
  harness,
  className,
}: {
  slug?: string | null;
  name?: string | null;
  logoUrl?: string | null;
  harness: HarnessMarkId;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("relative block size-11 shrink-0", className)}>
      <IntegrationMark slug={slug} name={name} logoUrl={logoUrl} tile="outline" tileSize={36} />
      <span className="absolute right-0 bottom-0 flex size-[22px] items-center justify-center overflow-hidden rounded-full bg-card">
        <HarnessMark mark={harness} tile="none" className="size-[18px]" />
      </span>
    </span>
  );
}
