import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { ToolStep } from "@/components/setup/tool-step";
import { VendorChoice } from "@/components/setup/vendor-choice";
import type { SetupStateData } from "@/lib/setup-queries";

/**
 * The record's vendor step, which Setup v2 draws as two screens: the integration (GRA-206; GRA-216)
 * until a starter is chosen, then the tool (`ToolStep`), where the task is picked before anything
 * is connected. Choosing a starter saves it on the record (`POST /api/setup/starter`), so a reload
 * lands on the tool screen; *Another integration* opens the ordinary form and its connection takes
 * the record to the goal step, which is the tool screen for that connection.
 */
export function VendorStep({ state }: { state: SetupStateData }) {
  if (state.setup?.starterId) return <ToolStep state={state} starterId={state.setup.starterId} />;
  return (
    <div className="flex flex-col gap-8">
      <SetupStepHeader
        title="Choose an integration"
        description="Graft connects one integration first and builds a small read-only tool for it. You can add more from the console after."
      />
      <VendorChoice state={state} />
    </div>
  );
}
