import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { VendorChoice } from "@/components/setup/vendor-choice";
import { StatusChip } from "@/components/status-chip";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { SetupStateData } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * The vendor step (GRA-206): which agent Setup runs as, so a reload visibly resumes with the same
 * one, and the starter vendors this deployment can connect (`VendorChoice`), each saying what the
 * first tool will show, with *Another vendor* last.
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
      <VendorChoice />
    </div>
  );
}
