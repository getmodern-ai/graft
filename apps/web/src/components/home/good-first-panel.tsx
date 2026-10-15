import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { HomeListFailed, HomePanel } from "@/components/home/home-panel";
import { AddIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RequestList } from "@/components/pending/request-row";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GOOD_FIRST_TILES, goodFirstIntegrations, tryLine } from "@/lib/home-checklist";
import { integrationsQuery } from "@/lib/integration-queries";
import { type SetupVendor, setupVendorsQuery } from "@/lib/setup-queries";

/**
 * *Good first integrations* (GRA-328; Figma 2099:10107): Setup's starters this deployment
 * connects, each with its curated task as the "Try" line, drawn while the person has no
 * integration. Starters only, so no catalogue (ADR 0001). Connect goes to Discover, as a
 * suggested tile's does. With nothing to offer the section is not drawn.
 */
export function GoodFirstPanel() {
  const vendors = useQuery(setupVendorsQuery);
  const integrations = useQuery(integrationsQuery);
  const tiles = goodFirstIntegrations(
    vendors.data?.vendors ?? [],
    integrations.data?.integrations ?? [],
  ).slice(0, GOOD_FIRST_TILES);
  const failed = vendors.isError && !vendors.data;
  if (!failed && tiles.length === 0) return null;

  return (
    <HomePanel
      title="Good first integrations"
      description="Connect one, then ask your agent the task under it."
      more={{
        label: "Browse integrations",
        render: <Link to="/integrations" search={{ tab: "discover" }} />,
      }}
    >
      {failed ? (
        <RequestList aria-label="Good first integrations">
          <HomeListFailed query={vendors} message="Could not load integrations." />
        </RequestList>
      ) : (
        <ul
          aria-label="Good first integrations"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {tiles.map((option) => (
            <GoodFirstTile key={option.starter.id} option={option} />
          ))}
        </ul>
      )}
    </HomePanel>
  );
}

function GoodFirstTile({ option: { starter } }: { option: SetupVendor }) {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 rounded-lg p-4">
        <div className="flex items-start justify-between gap-2">
          <IntegrationMark
            slug={starter.id}
            name={starter.displayName}
            tile="outline"
            tileSize={36}
          />
          <Button
            variant="outline"
            size="sm"
            aria-label={`Connect ${starter.displayName}`}
            nativeButton={false}
            render={<Link to="/integrations" search={{ tab: "discover" }} />}
          >
            <AddIcon />
            Connect
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{starter.displayName}</span>
          <span className="text-muted-foreground text-xs">{tryLine(starter)}</span>
        </div>
      </Card>
    </li>
  );
}
