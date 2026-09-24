import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { VendorChoice } from "@/components/setup/vendor-choice";
import { StatusChip } from "@/components/status-chip";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { SetupStateData } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * The integration step (GRA-206; GRA-216, `vendor` in the record): which agent Setup runs as, so
 * a reload visibly resumes with the same one, and the starter integrations this deployment can
 * connect in one click (`VendorChoice`), each saying what the first tool will show, with *Another
 * integration* last. Its footer carries Back to the harness and
 * Continue (GRA-215).
 */
export function VendorStep({ state }: { state: SetupStateData }) {
  const { agent } = state;
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Choose an integration"
        description="Graft connects one integration first and acquires a small read-only tool for it."
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
      <VendorChoice state={state} />
    </div>
  );
}
