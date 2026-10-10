import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { ToolStep } from "@/components/setup/tool-step";
import { VendorChoice } from "@/components/setup/vendor-choice";
import {
  type DirectoryEntry,
  type SetupStateData,
  setupDirectoryHomeQuery,
} from "@/lib/setup-queries";

/**
 * The record's vendor step, which Setup v2 draws as two screens: the integration (the frames' *2
 * App*: the directory this deployment searches, `VendorChoice`) until one is chosen, then the tool
 * (`ToolStep`), where the task is picked before anything is connected. A starter is saved on the
 * record (`POST /api/setup/starter`), so a reload lands on its tool screen; another directory
 * integration is held by this page until its task is chosen, when the task route connects it
 * (`POST /api/setup/task` with its slug). *Anything else* opens the ordinary form and its
 * connection takes the record to the goal step, the tool screen for that connection.
 */
/**
 * The directory integration the page holds before its task is chosen, provided by the page
 * (`routes/_auth/setup.tsx`) so the stepper, the eyebrow and browser Back read the tool screen as
 * the *Tool* stage though the record still stands on `vendor`.
 */
export const SetupAppContext = createContext<{
  app: DirectoryEntry | null;
  setApp: (app: DirectoryEntry | null) => void;
}>({ app: null, setApp: () => {} });

export function VendorStep({ state }: { state: SetupStateData }) {
  const { app, setApp } = useContext(SetupAppContext);
  const home = useQuery(setupDirectoryHomeQuery);
  if (state.setup?.starterId) return <ToolStep state={state} starterId={state.setup.starterId} />;
  if (app) return <ToolStep state={state} app={app} onBack={() => setApp(null)} />;
  const large = home.data && home.data.total > home.data.popular.length;
  return (
    <div className="flex flex-col gap-8">
      <SetupStepHeader
        title="Connect Graft to anything."
        description={
          large
            ? `${home.data.total.toLocaleString("en")} integrations in the directory, and any other service with an API. Graft reads the docs and builds the tool.`
            : "Pick an integration, or any other service with an API. Graft reads the docs and builds the tool."
        }
      />
      <VendorChoice state={state} onChooseApp={setApp} />
    </div>
  );
}
