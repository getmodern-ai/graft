import { InfoIcon } from "@/components/icons";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { StatusChip } from "@/components/status-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { SetupStateData } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * The vendor step, a placeholder until GRA-206 puts the starter vendors here: it says which agent
 * Setup runs as, so a reload visibly resumes with the same one, and how a vendor is connected
 * today: skipped, the console stops sending the person here, so the Connections screen is
 * reachable (a link from here would be intercepted straight back). GRA-206 replaces the body.
 */
export function VendorStep({ state }: { state: SetupStateData }) {
  const { agent } = state;
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Choose a vendor"
        description="Graft connects one vendor first and builds a small read-only tool for it."
      />
      {agent ? (
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>
              {agent.name}
              <StatusChip chip={agentStatusChip(agent)} />
            </ItemTitle>
            <ItemDescription>The agent Setup runs as. Its first tool lands here.</ItemDescription>
          </ItemContent>
        </Item>
      ) : null}
      <Alert>
        <InfoIcon />
        <AlertTitle>Starter vendors are on their way</AlertTitle>
        <AlertDescription>
          This step will offer a short list of vendors to start with. Until then, skip Setup for now
          and add a connection on the Connections screen. Your agent stays as it is.
        </AlertDescription>
      </Alert>
    </div>
  );
}
