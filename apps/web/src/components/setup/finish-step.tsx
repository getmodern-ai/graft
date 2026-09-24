import { type SetupHarness, setupHarnessOf } from "@graft/core/setup/harness";
import { isAwaitingHarness } from "@graft/core/setup/setup.rules";
import { suggestedFirstSentence } from "@graft/core/setup/setup-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { SetupPromptBlock } from "@/components/agent/setup-prompt-block";
import { CodeBlock } from "@/components/code-block";
import { InfoIcon, KeyIcon, WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { agentKeys, issueAgentToken } from "@/lib/agent-queries";
import { harnessSetup, mcpEndpointUrl } from "@/lib/mcp-snippet";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/safe-redirect";
import {
  type FinishVariant,
  finishSections,
  finishVariant,
  promptToolOf,
  snippetShapeOf,
  type ToolArrival,
  tokenReplaceable,
  toolArrival,
} from "@/lib/setup-finish";
import type { setupFinishedToast } from "@/lib/setup-page";
import {
  finishSetup,
  type SetupFinish,
  type SetupStateData,
  type SetupTool,
  setupKeys,
  setupToolQuery,
} from "@/lib/setup-queries";

/** How often the step reads the state again while the job is still acquiring the tool. */
const ARRIVING_POLL_MS = 3_000;

export type FinishStepProps = {
  state: SetupStateData;
  /** The finish's answer once Finish Setup was pressed on this page, with the token if one was issued. */
  finished: SetupFinish | null;
  /** Finish Setup succeeded; the page decides whether to leave, close or stay (`afterSetupFinish`). */
  onFinished: (answer: SetupFinish, tool: Parameters<typeof setupFinishedToast>[1]) => void;
  /** A token harness's token issued on this page before the finish, held by the page. */
  issuedToken: string | null;
  onTokenIssued: (token: string) => void;
};

/**
 * The finish step (GRA-208; GRA-202, *The finish step and the prompt* and *Completion*), **short**
 * since GRA-215: one sentence, then what `finishSections` lists for the harness's kind, and the
 * footer's **Finish Setup**, which completes the record (`POST /api/setup/finish`) so the console's
 * intercept ends, and leaves the page in the same press.
 *
 * - An **OAuth harness** (Claude, ChatGPT, Claude Code, Codex): the setup prompt with *Copy
 *   prompt*, which walks the harness through adding Graft and consenting as this agent; the
 *   connector URL and the manual steps sit behind *Set it up by hand*.
 * - A **static-token harness** (Hermes, OpenClaw, another MCP client): the token block and the
 *   prompt, the configuration blocks behind the same disclosure. The token is issued by the
 *   footer's *Issue the token* (`POST /api/agents/:id/token`) before the finish, so Finish Setup
 *   stays one press that leaves; it is held by the page (`SetupRoute`), never the query cache.
 *   A token the page lost to a reload before it was saved is replaced by *Issue a new token*,
 *   the same route, while Setup is not completed; the old one stops working (ADR 0024 as amended
 *   2026-09-25).
 * - A Setup that **adopted** an agent (no harness on the record): the one request to ask in the
 *   chat.
 *
 * While the job the person continued past still runs, the prompt names the tool as arriving and
 * the state is read every three seconds, so the tool is named once it lands.
 */
export function FinishStep({
  state,
  finished,
  onFinished,
  issuedToken,
  onTokenIssued,
}: FinishStepProps) {
  const context = useQuery(setupToolQuery);
  const queryClient = useQueryClient();
  const arrival = context.data ? toolArrival(context.data) : null;
  const arriving = arrival?.kind === "arriving";

  // The record learns the tool on a read of the state (`GET /api/setup`), and this step's context
  // is under the same key, so one invalidation reads both.
  useEffect(() => {
    if (!arriving) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: setupKeys.current });
    }, ARRIVING_POLL_MS);
    return () => clearInterval(timer);
  }, [arriving, queryClient]);

  const finish = useMutation({
    mutationFn: finishSetup,
    onSuccess: (answer) => {
      // The state goes into the one cache entry the intercept reads; the token does not.
      const { token: _token, ...completed } = answer;
      queryClient.setQueryData(setupKeys.current, completed);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      onFinished(
        answer,
        arrival?.kind === "landed" || arrival?.kind === "arriving" ? arrival : { kind: "none" },
      );
    },
  });
  const agent = finished?.agent ?? state.agent;
  const issue = useMutation({
    mutationFn: () => {
      if (!agent) throw new Error("Setup has no agent to issue a token to");
      return issueAgentToken(agent.id);
    },
    onSuccess: ({ token }) => {
      onTokenIssued(token);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void queryClient.invalidateQueries({ queryKey: setupKeys.current });
    },
  });

  if (context.isPending) return <Loader />;
  if (context.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        <RetryNotice
          error={context.error}
          message="Could not load the finish."
          onRetry={() => void context.refetch()}
          retrying={context.isFetching}
        />
      </p>
    );
  }

  const harness = state.setup?.harness ?? null;
  const variant = finishVariant(harness);
  const entry = harness ? setupHarnessOf(harness) : null;
  const agentName = agent?.name ?? "your agent";
  const token = finished?.token ?? issuedToken;
  const sections = finishSections(variant, {
    issued: token !== null,
    awaiting: agent !== null && isAwaitingHarness(agent),
    replaceable: finished === null && agent !== null && tokenReplaceable(agent),
  });
  const origin = window.location.origin;
  const promptTool = promptToolOf(context.data);
  // Finish Setup is one press: held while it runs and after it succeeded, until the page leaves.
  const busy = finish.isPending || finish.isSuccess || issue.isPending;

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={entry ? `Connect ${entry.label}` : "Ask in the chat"}
        description={finishSentence(variant, entry?.label ?? "", agentName)}
      />

      {arrival?.kind === "failed" ? <BuildFailed arrival={arrival} /> : null}

      {sections.token && harness ? (
        <TokenBlock
          state={sections.token}
          token={token}
          agentName={agentName}
          replaceable={sections.token === "saved" ? sections.reissue : finished === null}
        />
      ) : null}

      {sections.askInChat ? <AskInChat context={context.data} /> : null}

      {sections.prompt && harness ? (
        <SetupPromptBlock
          harness={harness}
          agentName={agentName}
          {...(context.data.connection
            ? { connection: { displayName: context.data.connection.displayName } }
            : {})}
          {...(promptTool ? { tool: promptTool } : {})}
        />
      ) : null}

      {sections.byHand && entry && harness ? (
        <SetupDisclosure label="Set it up by hand">
          <CodeBlock label="MCP server URL" code={mcpEndpointUrl(origin)} copyLabel="Copy URL" />
          {sections.byHand === "oauth" ? (
            <Steps
              steps={[
                ...entry.steps,
                `On Graft's consent page, ${agentName} is already chosen under Connect as. Choose Connect.`,
              ]}
            />
          ) : (
            <ConfigBlocks harness={harness} origin={origin} token={token} steps={entry.steps} />
          )}
        </SetupDisclosure>
      ) : null}

      {finished ? (
        // Only a page the finish could not leave: a token the finish itself issued, or a card popup
        // the browser would not close.
        <div className="flex justify-end">
          <Button nativeButton={false} render={<Link to={DEFAULT_SIGNED_IN_PATH} />}>
            Open the console
          </Button>
        </div>
      ) : (
        <SetupFooter state={state} disabled={busy}>
          {sections.reissue ? (
            <Button variant="outline" disabled={busy} onClick={() => issue.mutate()}>
              {issue.isPending ? "Issuing a new token…" : "Issue a new token"}
            </Button>
          ) : null}
          {sections.primary === "issue_token" ? (
            <Button disabled={busy} onClick={() => issue.mutate()}>
              {issue.isPending ? "Issuing the token…" : "Issue the token"}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => finish.mutate()}>
              {busy ? "Finishing…" : "Finish Setup"}
            </Button>
          )}
        </SetupFooter>
      )}
    </div>
  );
}

/** The step's one sentence, per harness kind. */
function finishSentence(variant: FinishVariant, harness: string, agentName: string): string {
  if (variant === "oauth") {
    return `Paste the prompt into ${harness} as your first message. It connects ${harness} to Graft as ${agentName} and asks for your first tool.`;
  }
  if (variant === "token") {
    return `Copy ${agentName}'s token, then paste the prompt into ${harness} as your first message.`;
  }
  return `${agentName} is already connected. Ask for what the tool does in the chat.`;
}

function BuildFailed({ arrival }: { arrival: Extract<ToolArrival, { kind: "failed" }> }) {
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>The tool did not pass</AlertTitle>
      <AlertDescription>
        {arrival.message} The prompt leaves the tool out; once your harness is connected, ask it for
        what you wanted and Graft acquires it there.
      </AlertDescription>
    </Alert>
  );
}

function Steps({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/**
 * The token block: shown once when issued, a note before, or the saved token's reminder.
 * `replaceable` is whether this page can still issue a new one (before its own finish).
 */
function TokenBlock({
  state,
  token,
  agentName,
  replaceable,
}: {
  state: "issued" | "to_issue" | "saved";
  token: string | null;
  agentName: string;
  replaceable: boolean;
}) {
  if (state === "issued" && token) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <Alert>
          <KeyIcon />
          <AlertTitle>This token is shown once</AlertTitle>
          <AlertDescription>
            {replaceable
              ? "Copy and save it now. If you lose it before you finish, issue a new one here, and this one stops working."
              : "Copy and save it now. If you lose it, revoke this agent and create a new one."}
          </AlertDescription>
        </Alert>
        <CodeBlock label="The agent's token" code={token} copyLabel="Copy token" />
      </div>
    );
  }
  if (state === "to_issue") {
    return (
      <Alert>
        <KeyIcon />
        <AlertTitle>The token is shown once</AlertTitle>
        <AlertDescription>
          Issue {agentName}'s token here and copy it before you finish.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert>
      <InfoIcon />
      <AlertTitle>{agentName} already has its token</AlertTitle>
      <AlertDescription>
        {replaceable
          ? "It was shown once when it was issued. Use the one you saved, or issue a new one if it was lost, and the old one stops working."
          : "It was shown once when it was issued. Use the one you saved."}
      </AlertDescription>
    </Alert>
  );
}

/** The create dialog's configuration blocks for a static-token harness, in its own shape. */
function ConfigBlocks({
  token,
  harness,
  origin,
  steps,
}: {
  token: string | null;
  harness: SetupHarness;
  origin: string;
  steps: readonly string[];
}) {
  const blocks = harnessSetup(snippetShapeOf(harness), origin, token ?? undefined);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Steps steps={steps} />
      <CodeBlock
        label={blocks.token.label}
        code={blocks.token.code}
        copyLabel={blocks.token.copyLabel}
        hint={blocks.token.hint}
      />
      <CodeBlock
        label={blocks.config.label}
        code={blocks.config.code}
        copyLabel={blocks.config.copyLabel}
        hint={blocks.config.hint}
      />
    </div>
  );
}

/** A Setup that adopted an agent: the first request, from the goal, to ask in the chat. */
function AskInChat({ context }: { context: SetupTool }) {
  const tool = promptToolOf(context);
  const sentence = tool ? suggestedFirstSentence(tool.goal) : "";
  if (!tool || !sentence) return null;
  return (
    <CodeBlock
      label="Ask in the chat"
      code={sentence}
      copyLabel="Copy request"
      wrap
      hint={
        tool.wireName
          ? `Your harness finds ${tool.wireName} among Graft's tools. If its list has not refreshed, ask it again in a new chat.`
          : "The tool is still on its way. Ask once it has joined the agent's tools, and the harness finds it there."
      }
    />
  );
}
