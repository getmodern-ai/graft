import type { AgentScopeMode } from "@graft/core";
import { SETUP_HARNESSES, type SetupHarness, setupHarnessOf } from "@graft/core/setup/harness";
import { isAwaitingHarness } from "@graft/core/setup/setup.rules";
import { useEffect, useRef, useState } from "react";

import { Loader } from "@/components/loader";
import { SetupChoice } from "@/components/setup/setup-choice";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readScopeMode, SCOPE_MODE_ITEMS } from "@/lib/scope-mode";
import { agentToAdopt } from "@/lib/setup-page";
import { nextSetup, type SetupStateData, startSetup } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

type Agent = SetupStateData["activeAgents"][number];

/**
 * Setup's first step (ADR 0024): which agent Setup runs as. With no active agent the person picks
 * the harness they run and Setup mints an agent for it, awaiting its harness; with one, Setup
 * starts as it without asking (a person who consented from a chat product already has the agent
 * the tool should land in); with several, the person picks which. The server decides the same
 * three ways (`startSetup` in `@graft/core`) and refuses a start that does not fit, so this step
 * only chooses which form to draw. A page opened from `find_tool`'s offer names its agent
 * (`agentId`, GRA-210): among several, Setup starts as that one without asking.
 */
export function HarnessStep({ state, agentId }: { state: SetupStateData; agentId?: string }) {
  // Returned to from a later step (GRA-215): the record already runs as its agent.
  if (state.setup?.agentId && state.agent) return <HarnessReview state={state} />;
  const adopt = agentToAdopt(state.activeAgents, agentId);
  if (adopt) return <AdoptOnlyAgent agent={adopt} />;
  if (state.activeAgents.length > 0) return <ChooseAgent state={state} />;
  return <ChooseHarness state={state} />;
}

/**
 * The harness step returned to (GRA-215, *The rail is navigable*): the harness chosen, which the
 * person may change while Setup's own agent still awaits its harness, since the harness decides
 * only the finish's instructions and the token-or-consent path. An agent that already has its token
 * or its client shows its harness read only, and an adopted agent (no harness on the record) is
 * shown as the agent Setup runs as. Continue walks on to the integration step with nothing else
 * changed (`POST /api/setup/next`).
 */
function HarnessReview({ state }: { state: SetupStateData }) {
  const recorded = state.setup?.harness ?? null;
  const agent = state.agent;
  const [harness, setHarness] = useState<SetupHarness | null>(recorded);
  const next = useSetupMutation(nextSetup);
  const changeable = recorded !== null && agent !== null && isAwaitingHarness(agent);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        next.mutate({ from: "harness", ...(harness && changeable ? { harness } : {}) });
      }}
    >
      {recorded ? (
        <>
          <SetupStepHeader
            title="Which harness do you use?"
            description={
              changeable
                ? `Setup made ${agent?.name ?? "an agent"} for this harness. Change it here until the harness connects; only the finish's instructions follow it.`
                : `${agent?.name ?? "The agent"} is connected to its harness already, so Setup keeps it.`
            }
          />
          <SetupChoice
            name="setup-harness"
            legend="Harness"
            options={SETUP_HARNESSES.map((entry) => ({
              value: entry.id,
              label: entry.label,
              description: entry.description,
            }))}
            value={harness}
            onChange={setHarness}
            disabled={!changeable || next.isPending}
          />
        </>
      ) : (
        <>
          <SetupStepHeader
            title={`Setup runs as ${agent?.name ?? "your agent"}`}
            description="Its harness was connected before Setup, so there is nothing to choose here."
          />
          {agent ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>
                  {agent.name}
                  <StatusChip chip={agentStatusChip(agent)} />
                </ItemTitle>
                <ItemDescription>
                  The tool Setup acquires lands in this agent's working set.
                </ItemDescription>
              </ItemContent>
            </Item>
          ) : null}
        </>
      )}
      <SetupFooter state={state} disabled={next.isPending}>
        <Button type="submit" disabled={next.isPending}>
          {next.isPending ? "Continuing…" : "Continue"}
        </Button>
      </SetupFooter>
    </form>
  );
}

/** The create dialog's defaults (`create-agent-dialog.tsx`), which Setup's agent starts from. */
const DEFAULT_CAP = "20";
const DEFAULT_IDLE_DAYS = "21";

/**
 * The scope's sentence under *Advanced options*. Not the create dialog's: that one points at a
 * picker, and Setup's agent is narrowed on its own page later, if at all. Under `listed` it starts
 * with no connection and the one Setup makes is added to it, as every agent's own proposal is.
 */
const SETUP_SCOPE_DESCRIPTION: Record<AgentScopeMode, string> = {
  all: "This agent can use every connection you have now or add later. Creating tools and making changes still require approval.",
  listed:
    "This agent can only use the connections you give it. The one you make in Setup is added, and you can add others on its page.",
};

function ChooseHarness({ state }: { state: SetupStateData }) {
  const [harness, setHarness] = useState<SetupHarness | null>(null);
  const [name, setName] = useState("");
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [idleDays, setIdleDays] = useState(DEFAULT_IDLE_DAYS);
  const [scopeMode, setScopeMode] = useState<AgentScopeMode>("all");
  const start = useSetupMutation(startSetup);

  const defaultName = harness ? setupHarnessOf(harness).agentName : "";

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!harness) return;
        start.mutate({
          harness,
          agent: {
            ...(name.trim() ? { name: name.trim() } : {}),
            workingSetCap: Number(cap),
            idleWindowDays: Number(idleDays),
            scopeMode,
          },
        });
      }}
    >
      <SetupStepHeader
        title="Which harness do you use?"
        description="Graft makes an agent for it now. You connect the harness to that agent at the end of Setup."
      />
      <SetupChoice
        name="setup-harness"
        legend="Harness"
        options={SETUP_HARNESSES.map((entry) => ({
          value: entry.id,
          label: entry.label,
          description: entry.description,
        }))}
        value={harness}
        onChange={setHarness}
        disabled={start.isPending}
      />

      <SetupDisclosure label="Advanced options">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="setup-agent-name">Agent name</FieldLabel>
            <Input
              id="setup-agent-name"
              placeholder={defaultName || "Enter agent name"}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>
              {defaultName
                ? `Left empty, the agent is called ${defaultName}.`
                : "Left empty, the agent is named after the harness."}
            </FieldDescription>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="setup-agent-cap">Working set cap</FieldLabel>
              <Input
                id="setup-agent-cap"
                type="number"
                min={1}
                step={1}
                required
                value={cap}
                onChange={(event) => setCap(event.target.value)}
              />
              <FieldDescription>Target number of tools in the working set.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-agent-idle">Idle window (days)</FieldLabel>
              <Input
                id="setup-agent-idle"
                type="number"
                min={1}
                step={1}
                required
                value={idleDays}
                onChange={(event) => setIdleDays(event.target.value)}
              />
              <FieldDescription>
                Days without use before a tool leaves the working set.
              </FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="setup-agent-scope">Scope</FieldLabel>
            <Select
              value={scopeMode}
              items={SCOPE_MODE_ITEMS}
              onValueChange={(next) => {
                const read = readScopeMode(next);
                if (read) setScopeMode(read);
              }}
            >
              <SelectTrigger id="setup-agent-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{SETUP_SCOPE_DESCRIPTION[scopeMode]}</FieldDescription>
          </Field>
        </FieldGroup>
      </SetupDisclosure>

      <SetupFooter state={state} disabled={start.isPending}>
        <Button type="submit" disabled={!harness || start.isPending}>
          {start.isPending ? "Creating agent…" : "Continue"}
        </Button>
      </SetupFooter>
    </form>
  );
}

/**
 * Several agents: which one Setup runs as. Never a guess (GRA-202, user story 6); each is shown with
 * its chip, so an agent awaiting its harness reads apart from one already connected.
 */
function ChooseAgent({ state }: { state: SetupStateData }) {
  const agents = state.activeAgents;
  const [agentId, setAgentId] = useState<string | null>(null);
  const start = useSetupMutation(startSetup);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (agentId) start.mutate({ agentId });
      }}
    >
      <SetupStepHeader
        title="Which agent should Setup use?"
        description="Setup connects a vendor and has Graft acquire a first tool for one of your agents. Its harness finds the tool there."
      />
      <SetupChoice
        name="setup-agent"
        legend="Agent"
        options={agents.map((agent) => ({
          value: agent.id,
          label: agent.name,
          description: agent.connectedVia
            ? `Connected from ${agent.connectedVia.clientName}`
            : agent.tokenPrefix
              ? `Token ${agent.tokenPrefix}…`
              : "No harness connected yet",
          aside: <StatusChip chip={agentStatusChip(agent)} />,
        }))}
        value={agentId}
        onChange={setAgentId}
        disabled={start.isPending}
      />
      <SetupFooter state={state} disabled={start.isPending}>
        <Button type="submit" disabled={!agentId || start.isPending}>
          {start.isPending ? "Starting…" : "Continue"}
        </Button>
      </SetupFooter>
    </form>
  );
}

/**
 * One agent, or the one the page's URL names: Setup starts as it at once, so the person lands on
 * the vendor step. The start is sent
 * once per mount (the ref holds React's development double effect to one request); a refused start
 * has toasted its sentence, and the button sends it again.
 */
function AdoptOnlyAgent({ agent }: { agent: Agent }) {
  const start = useSetupMutation(startSetup);
  const sent = useRef(false);
  const { mutate } = start;

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    mutate({ agentId: agent.id });
  }, [agent.id, mutate]);

  if (start.isError) {
    return (
      <div className="flex flex-col gap-6">
        <SetupStepHeader
          title={`Setup runs as ${agent.name}`}
          description="Setup could not start. Try again, or skip it for now."
        />
        <div>
          <Button onClick={() => mutate({ agentId: agent.id })}>Try again</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={`Setup runs as ${agent.name}`}
        description="The tool Setup acquires lands in this agent's working set."
      />
      <Loader />
    </div>
  );
}
