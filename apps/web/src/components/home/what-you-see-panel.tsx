import { HomePanel, HomeRow, HomeRowText } from "@/components/home/home-panel";
import { HistoryIcon, InboxIcon, SmartToyIcon } from "@/components/icons";
import { RequestList } from "@/components/pending/request-row";

const ROWS = [
  {
    icon: InboxIcon,
    title: "Requests",
    detail: "When an agent needs your OK, it lands here.",
  },
  { icon: SmartToyIcon, title: "Your agents", detail: "Every agent you add Graft to." },
  {
    icon: HistoryIcon,
    title: "Recent activity",
    detail: "What your agents ran, and what you said no to.",
  },
] as const;

/**
 * *What you'll see here* (GRA-328; Figma 2099:10107): the empty Home's stand-in for the panels it
 * will grow, one row per panel, with the sidebar's icon for the screen each summarises.
 */
export function WhatYouSeePanel() {
  return (
    <HomePanel
      title="What you'll see here"
      description="Home fills up as your agents start working."
    >
      <RequestList aria-label="What you'll see here">
        {ROWS.map(({ icon: Icon, title, detail }) => (
          <HomeRow key={title} className="items-start">
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <HomeRowText title={title} detail={detail} detailClassName="whitespace-normal" />
          </HomeRow>
        ))}
      </RequestList>
    </HomePanel>
  );
}
