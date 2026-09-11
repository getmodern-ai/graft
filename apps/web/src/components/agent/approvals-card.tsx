import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Agent, Tool } from "@/lib/agent-queries";
import {
  type Approval,
  approvalKeys,
  relaxApproval,
  withdrawApproval,
} from "@/lib/approval-queries";

/**
 * The agent's standing approvals (ADR 0008): what the person has said about each tool, per agent.
 * The relax switch lifts a destructive tool's per-call ask — and cannot be switched back except by
 * withdrawing, which is the server's rule (`relaxDestructiveApproval` has no inverse; `revokeApproval`
 * does): withdrawn, the tool asks again on its next call, which is also the one way back from a no.
 */
export function ApprovalsCard({
  agent,
  approvals,
  tools,
}: {
  agent: Agent;
  approvals: readonly Approval[];
  tools: readonly Tool[];
}) {
  const queryClient = useQueryClient();
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(agent.id) });

  const relax = useMutation({
    mutationFn: (toolId: string) => relaxApproval(agent.id, toolId),
    onSuccess: async () => {
      await invalidate();
      toast.success("Relaxed", { description: "Its next calls pass without asking." });
    },
  });
  const withdraw = useMutation({
    mutationFn: (toolId: string) => withdrawApproval(agent.id, toolId),
    onSuccess: async () => {
      await invalidate();
      toast.success("Withdrawn", { description: "The tool asks again on its next call." });
    },
  });
  const busy = relax.isPending || withdraw.isPending || agent.revokedAt !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
        <CardDescription>
          Your standing answers for this agent, per tool. Reads never ask; a write asks once and the
          answer holds; a destructive tool asks every call until relaxed here or in the ask itself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {approvals.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing answered yet — the first write this agent runs will ask.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Answer</TableHead>
                <TableHead>Decided</TableHead>
                <TableHead>Asks every call</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((approval) => {
                const tool = toolsById.get(approval.toolId);
                return (
                  <TableRow key={approval.toolId}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-xs">
                          {tool ? `${tool.vendor}__${tool.name}` : approval.toolId}
                        </code>
                        {tool ? (
                          <ToolAnnotations
                            readOnly={tool.readOnly}
                            destructive={tool.destructive}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {approval.decision === "allow" ? (
                        <Badge variant="success">allowed</Badge>
                      ) : (
                        <Badge variant="destructive">denied</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Time iso={approval.decidedAt} />
                    </TableCell>
                    <TableCell>
                      {tool?.destructive ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={!approval.perCallRelaxed}
                            disabled={
                              busy || approval.perCallRelaxed || approval.decision !== "allow"
                            }
                            onCheckedChange={(checked) => {
                              if (!checked) relax.mutate(approval.toolId);
                            }}
                            aria-label="Ask on every call"
                          />
                          <span className="text-muted-foreground text-xs">
                            {approval.perCallRelaxed ? "relaxed" : "yes"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {tool?.readOnly ? "never" : "once"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => withdraw.mutate(approval.toolId)}
                      >
                        Withdraw
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
