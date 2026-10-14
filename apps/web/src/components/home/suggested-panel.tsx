import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { HomeListFailed, HomePanel } from "@/components/home/home-panel";
import { AddIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RequestList } from "@/components/pending/request-row";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { homeSuggestions, suggestionLine } from "@/lib/home";
import {
  integrationsQuery,
  type SuggestedIntegration,
  suggestedIntegrationsQuery,
} from "@/lib/integration-queries";

/**
 * *Suggested for your agents* (GRA-327): GRA-305's read, one tile per integration an agent of the
 * person's asked for and the person has not connected (ADR 0001 as amended 2026-10-14: nothing
 * about anyone else, nothing quoted from a chat). Connect goes to Discover, whose connect dialog
 * (GRA-322) is where a connection with no agent asking is made. With nothing to suggest the
 * section is not drawn, as the Integrations banner is not; a failed read keeps the heading and
 * says so with a Retry.
 */
export function SuggestedPanel() {
  const suggested = useQuery(suggestedIntegrationsQuery);
  const integrations = useQuery(integrationsQuery);
  const tiles = homeSuggestions(
    suggested.data?.suggestions ?? [],
    integrations.data?.integrations ?? [],
  );
  const failed = suggested.isError && !suggested.data;
  if (!failed && tiles.length === 0) return null;

  return (
    <HomePanel
      title="Suggested for your agents"
      description="Integrations your agents asked for that you haven't connected."
      more={{
        label: "Browse integrations",
        render: <Link to="/integrations" search={{ tab: "discover" }} />,
      }}
    >
      {failed ? (
        <RequestList aria-label="Suggested integrations">
          <HomeListFailed query={suggested} message="Could not load suggestions." />
        </RequestList>
      ) : (
        <ul
          aria-label="Suggested integrations"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {tiles.map((suggestion) => (
            <SuggestedTile key={suggestion.vendor} suggestion={suggestion} />
          ))}
        </ul>
      )}
    </HomePanel>
  );
}

function SuggestedTile({ suggestion }: { suggestion: SuggestedIntegration }) {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 rounded-lg p-4">
        <div className="flex items-start justify-between gap-2">
          <IntegrationMark
            slug={suggestion.vendor}
            name={suggestion.displayName}
            logoUrl={suggestion.logoUrl}
            tile="outline"
            tileSize={36}
          />
          <Button
            variant="outline"
            size="sm"
            aria-label={`Connect ${suggestion.displayName}`}
            nativeButton={false}
            render={<Link to="/integrations" search={{ tab: "discover" }} />}
          >
            <AddIcon />
            Connect
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{suggestion.displayName}</span>
          <span className="text-muted-foreground text-xs">{suggestionLine(suggestion)}</span>
        </div>
      </Card>
    </li>
  );
}
