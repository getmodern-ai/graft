import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import type { Agent, ConnectedHarness } from "@/lib/agent-queries";

export function ConnectedHarnesses({
  agent,
  harnesses,
}: {
  agent: Agent;
  harnesses: readonly ConnectedHarness[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected harnesses</CardTitle>
        <CardDescription>Harnesses authorized to use this agent through OAuth.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {harnesses.length ? (
          <ItemGroup aria-label="Connected harnesses">
            {harnesses.map((harness) => (
              <Item key={harness.clientId} role="listitem" variant="muted" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none w-auto break-words">
                    {harness.clientName}
                  </ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <p className="text-muted-foreground text-sm">No harnesses have OAuth access.</p>
        )}
        {agent.tokenPrefix && !agent.revokedAt ? (
          <p className="text-muted-foreground text-sm">
            Harnesses using this agent's static token are not identified here.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
