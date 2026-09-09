import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { agentKeys } from "@/lib/agent-queries";
import {
  answerPendingAction,
  type PendingActionView,
  pendingKeys,
} from "@/lib/pending-action-queries";

/**
 * One ask (ADR 0006, ADR 0008): who is asking, what tool, against which vendor, and the tool's
 * description — marked as the agent's model's own words, because that is what it is, and a person
 * deciding on a write should know the sentence was not written by anyone accountable. Approve and
 * decline answer the pending action; the waiting MCP call resumes on the answer (GRA-23). For a
 * destructive tool a switch relaxes the per-call ask in the same answer.
 */
export function PendingActionCard({
  action,
  onAnswered,
}: {
  action: PendingActionView;
  onAnswered?: () => void;
}) {
  const queryClient = useQueryClient();
  const [relax, setRelax] = useState(false);
  const destructive = action.tool?.destructive ?? false;

  const answer = useMutation({
    mutationFn: (decision: "allow" | "deny") =>
      answerPendingAction(action.id, {
        decision,
        ...(destructive && decision === "allow" ? { relaxPerCall: relax } : {}),
      }),
    onSuccess: (_result, decision) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(decision === "allow" ? "Approved" : "Declined", {
        description: "The agent's waiting call resumes with your answer.",
      });
      onAnswered?.();
    },
  });

  const expired = new Date(action.expiresAt).getTime() <= Date.now();
  const settled = action.answeredAt !== null || expired;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{action.agent.name} asks to run</span>
          {action.tool ? (
            <code className="font-mono">
              {action.tool.vendor}__{action.tool.name}
            </code>
          ) : (
            <span>{action.kind}</span>
          )}
          {action.tool ? (
            <ToolAnnotations
              readOnly={action.tool.readOnly}
              destructive={action.tool.destructive}
            />
          ) : null}
        </CardTitle>
        <CardDescription>
          Asked <Time iso={action.createdAt} />
          {" · "}
          {expired ? (
            <>
              expired <Time iso={action.expiresAt} />
            </>
          ) : (
            <>
              expires <Time iso={action.expiresAt} />
            </>
          )}
          {action.connection ? (
            <>
              {" · against "}
              <span className="font-medium text-foreground">{action.connection.displayName}</span>{" "}
              at <code className="font-mono text-xs">{action.connection.primaryHost}</code>
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {action.tool ? (
          <figure className="flex flex-col gap-1.5">
            <figcaption className="flex items-center gap-2 text-muted-foreground text-xs">
              <Badge variant="outline">written by the agent's model</Badge>
              What the tool says it does — not reviewed by a person.
            </figcaption>
            <blockquote className="border-l-2 pl-3 italic">{action.tool.description}</blockquote>
          </figure>
        ) : null}
        {destructive && !settled ? (
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id={`relax-${action.id}`}
              checked={relax}
              onCheckedChange={(checked) => setRelax(checked)}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`relax-${action.id}`}>
                Stop asking for every call of this destructive tool
              </Label>
              <p className="text-muted-foreground text-xs">
                A destructive tool asks every time until you relax it. Relaxed, this approval holds
                like an ordinary write's and later calls pass silently for this agent.
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>
      {settled ? (
        <CardFooter className="text-muted-foreground text-sm">
          {action.answeredAt ? (
            <>
              Answered <Time iso={action.answeredAt} />.
            </>
          ) : (
            "This ask expired without an answer; the agent will ask again if it still needs to."
          )}
        </CardFooter>
      ) : (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={answer.isPending}
            onClick={() => answer.mutate("deny")}
          >
            Decline
          </Button>
          <Button disabled={answer.isPending} onClick={() => answer.mutate("allow")}>
            Approve
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
