import type * as React from "react";

import { IntegrationMark } from "@/components/marks";

/**
 * An integration in Discover's grids (the frames' `Graft / App tile`, Figma 2043:7028): a bordered
 * card, 16px in, the mark in a 40px outlined tile with the tile's action across from it, then the
 * name and one muted line, the directory's description or which agent asked.
 */
export function IntegrationTile({
  slug,
  name,
  logoUrl,
  subline,
  action,
}: {
  /** The vendor slug or a starter's id, for the bundled mark. */
  slug: string;
  name: string;
  logoUrl: string | null;
  subline?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <IntegrationMark
          slug={slug}
          name={name}
          logoUrl={logoUrl}
          tile="outline"
          tileSize={40}
          size={22}
        />
        {action}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate font-medium text-base">{name}</h3>
        {subline ? <p className="line-clamp-2 text-muted-foreground text-xs">{subline}</p> : null}
      </div>
    </li>
  );
}

/** The grid the tiles sit in: four across at the frame's width, gap 24 as the frame spaces them. */
export function IntegrationTileGrid({ children }: { children: React.ReactNode }) {
  return <ul className="grid gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-4">{children}</ul>;
}
