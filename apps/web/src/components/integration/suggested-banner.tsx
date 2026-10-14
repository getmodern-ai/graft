import { Link } from "@tanstack/react-router";

import { ArrowForwardIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { SuggestedIntegration } from "@/lib/integration-queries";
import { suggestedBanner } from "@/lib/integrations-list";

/** How many marks the banner draws before the names say the rest. */
const BANNER_MARKS = 4;

/**
 * "Your agents asked about N integrations you haven't connected" (Figma 2059:8664; GRA-305's read,
 * ADR 0001 as amended 2026-10-14: only the person's own agents' asks, nothing about other people).
 * Composed from `Item` on the muted band, the marks in outlined tiles, and one link to Discover.
 * Draws nothing when there is nothing to suggest.
 */
export function SuggestedBanner({ suggested }: { suggested: readonly SuggestedIntegration[] }) {
  const banner = suggestedBanner(suggested);
  if (!banner) return null;
  return (
    <Item variant="outline" className="gap-4 bg-muted/50 px-5 py-4">
      <span className="hidden shrink-0 items-center gap-1 sm:flex">
        {suggested.slice(0, BANNER_MARKS).map((suggestion) => (
          <IntegrationMark
            key={suggestion.vendor}
            slug={suggestion.vendor}
            name={suggestion.displayName}
            logoUrl={suggestion.logoUrl}
            tile="outline"
            tileSize={32}
            size={18}
          />
        ))}
      </span>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="line-clamp-none">{banner.title}</ItemTitle>
        <ItemDescription>{banner.names}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/integrations" search={{ tab: "discover" }} />}
        >
          See suggestions
          <ArrowForwardIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}
