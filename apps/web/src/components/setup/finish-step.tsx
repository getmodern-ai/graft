import { type SetupHarness, setupHarnessOf } from "@graft/core/setup/harness";
import { isAwaitingHarness } from "@graft/core/setup/setup.rules";
import { suggestedFirstSentence } from "@graft/core/setup/setup-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { SetupPromptBlock } from "@/components/agent/setup-prompt-block";
import { CodeBlock } from "@/components/code-block";
import { CheckCircleIcon, InfoIcon, KeyIcon, WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { agentKeys } from "@/lib/agent-queries";
import { harnessSetup, mcpEndpointUrl } from "@/lib/mcp-snippet";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/safe-redirect";
import {
  finishVariant,
  promptToolOf,
  snippetShapeOf,
  type ToolArrival,
  toolArrival,
} from "@/lib/setup-finish";
import {
  finishSetup,
  type SetupFinish,
  type SetupStateData,
  type SetupTool,
  setupKeys,
  setupToolQuery,
} from "@/lib/setup-queries";

/** How often the step reads the state again while the tool is still being built. */
const ARRIVING_POLL_MS = 3_000;

/**
 * The finish step (GRA-208; GRA-202, *The finish step and the prompt* and *Completion*): the
 * harness's connection instructions and the setup prompt personalised with the agent, the
 * connection and the tool (`SetupPromptBlock` over `@graft/core`'s `setupPrompt`), then **Finish
 * Setup**, which completes the record (`POST /api/setup/finish`) so the console's intercept ends.
 *
 * - A **static-token harness** (Hermes, OpenClaw, another MCP client): the finish issues the
 *   agent's token in the same request, and the step shows it once with the configuration blocks in
 *   the shape the create dialog draws. The token is held in the page's state (`SetupRoute`), never
 *   the query cache, so the step keeps showing it after the record reads `completed`.
 * - An **OAuth harness** (Claude, ChatGPT, Claude Code, Codex): the connector URL and the steps,
 *   ending on the consent page, which pre-selects this agent (`consentDefaultAgent`).
 * - A Setup that **adopted** an agent (no harness on the record): its harness is connected, so the
 *   step says what to ask in the chat instead.
 *
 * While the build the person continued past still runs, the prompt names the tool as arriving and
 * the state is read every three seconds, so the tool is named once it lands.
 */
export function FinishStep({
  state,
  finished,
  onFinished,
}: {
  state: SetupStateData;
  /** The finish's answer once Finish Setup was pressed on this page, with the token if one was issued. */
  finished: SetupFinish | null;
  onFinished: (answer: SetupFinish) => void;
}) {
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
      onFinished(answer);
      // The state goes into the one cache entry the intercept reads; the token does not.
      const { token: _token, ...completed } = answer;
      queryClient.setQueryData(setupKeys.current, completed);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
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

  const agent = finished?.agent ?? state.agent;
  const harness = state.setup?.harness ?? null;
  const variant = finishVariant(harness);
  const entry = harness ? setupHarnessOf(harness) : null;
  const agentName = agent?.name ?? "your agent";
  // The token is issued only to an agent still awaiting its harness; one issued earlier, from
  // *Connect a harness*, is the person's already.
  const issues = variant === "token" && agent !== null && isAwaitingHarness(agent);
  const token = finished?.token ?? null;
  const origin = window.location.origin;
  const promptTool = promptToolOf(context.data);

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title={entry ? `Connect ${entry.label}` : "Ask in the chat"}
        description={
          variant === "token"
            ? `Put ${agentName}'s token and the configuration into ${entry?.label}, then paste the prompt as your first message.`
            : variant === "oauth"
              ? `Add Graft to ${entry?.label}, connect as ${agentName}, then paste the prompt as your first message.`
              : `${agentName} is already connected, so there is nothing to set up. Ask for what the tool does in the chat.`
        }
      />

      <ToolStatus arrival={arrival} agentName={agentName} />

      {variant === "oauth" && entry ? (
        <>
          <CodeBlock label="MCP server URL" code={mcpEndpointUrl(origin)} copyLabel="Copy URL" />
          <Steps
            steps={[
              ...entry.steps,
              `On Graft's consent page, ${agentName} is already chosen under Connect as. Choose Connect.`,
            ]}
          />
        </>
      ) : null}

      {variant === "token" && harness ? (
        token ? (
          <TokenBlocks token={token} harness={harness} origin={origin} steps={entry?.steps ?? []} />
        ) : issues ? (
          <Alert>
            <KeyIcon />
            <AlertTitle>The token is shown once</AlertTitle>
            <AlertDescription>
              Finishing issues {agentName}'s token and shows it here with the configuration. Copy it
              before you leave this page.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Alert>
              <InfoIcon />
              <AlertTitle>{agentName} already has its token</AlertTitle>
              <AlertDescription>
                It was shown once when it was issued. Put the one you saved where the configuration
                below reads it.
              </AlertDescription>
            </Alert>
            <TokenBlocks harness={harness} origin={origin} steps={entry?.steps ?? []} />
          </>
        )
      ) : null}

      {variant === "adopted" ? (
        <AskInChat context={context.data} />
      ) : harness && (variant === "oauth" || token || !issues) ? (
        <SetupPromptBlock
          harness={harness}
          agentName={agentName}
          {...(context.data.connection
            ? { connection: { displayName: context.data.connection.displayName } }
            : {})}
          {...(promptTool ? { tool: promptTool } : {})}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {finished ? (
          <Button nativeButton={false} render={<Link to={DEFAULT_SIGNED_IN_PATH} />}>
            Open the console
          </Button>
        ) : (
          <Button disabled={finish.isPending} onClick={() => finish.mutate()}>
            {finish.isPending
              ? issues
                ? "Issuing the token…"
                : "Finishing…"
              : issues
                ? "Issue the token and finish"
                : "Finish Setup"}
          </Button>
        )}
      </div>
    </div>
  );
}

function ToolStatus({ arrival, agentName }: { arrival: ToolArrival | null; agentName: string }) {
  if (!arrival || arrival.kind === "none") return null;
  if (arrival.kind === "landed") {
    return (
      <Item variant="outline">
        <ItemMedia variant="icon">
          <CheckCircleIcon />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{arrival.wireName}</ItemTitle>
          <ItemDescription>In {agentName}'s tools, ready for the harness to call.</ItemDescription>
        </ItemContent>
      </Item>
    );
  }
  if (arrival.kind === "arriving") {
    return (
      <Alert>
        <Spinner />
        <AlertTitle>The tool is still being built</AlertTitle>
        <AlertDescription>
          It joins {agentName}'s tools when the build passes, and the prompt says so. You can finish
          now.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>The build did not pass</AlertTitle>
      <AlertDescription>
        {arrival.message} The prompt leaves the tool out; once your harness is connected, ask it for
        what you wanted and Graft builds it there.
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

/** The create dialog's blocks for a static-token harness, in its own shape, with the token when known. */
function TokenBlocks({
  token,
  harness,
  origin,
  steps,
}: {
  token?: string;
  harness: SetupHarness;
  origin: string;
  steps: readonly string[];
}) {
  const blocks = harnessSetup(snippetShapeOf(harness), origin, token);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {token ? (
        <Alert>
          <KeyIcon />
          <AlertTitle>This token is shown once</AlertTitle>
          <AlertDescription>
            Copy and save it now. If you lose it, revoke this agent and create a new one.
          </AlertDescription>
        </Alert>
      ) : null}
      {token ? <CodeBlock label="The agent's token" code={token} copyLabel="Copy token" /> : null}
      <CodeBlock label="MCP server URL" code={mcpEndpointUrl(origin)} copyLabel="Copy URL" />
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
          : "The tool is still being built. Ask once it has joined the agent's tools, and the harness finds it there."
      }
    />
  );
}
