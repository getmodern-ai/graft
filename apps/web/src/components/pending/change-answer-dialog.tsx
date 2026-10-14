import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  approvalKeys,
  approvalsQuery,
  buildApprovalsQuery,
  setApprovalAskEveryCall,
  setApprovalDecision,
  setVendorApprovalDestructive,
  vendorApprovalsQuery,
  withdrawApproval,
  withdrawBuildApproval,
  withdrawVendorApproval,
} from "@/lib/approval-queries";
import { toolsQuery } from "@/lib/connection-queries";
import { pendingKeys } from "@/lib/pending-action-queries";
import {
  type ChangeTargets,
  standingBuild,
  standingTool,
  standingVendor,
  toolChangeView,
} from "@/lib/request-done";

/**
 * Change on a Done row (GRA-312; ADR 0008 as amended 2026-10-14): what stands **now** for the
 * agent, read fresh, never the answer the row recorded. Each line offers only what a route does:
 * a tool's answer set outright, its ask-every-call switch and Withdraw (GRA-302's `PUT`, GRA-23's
 * routes); an integration's approval widened, narrowed or withdrawn where one stands; a
 * connection's build approval withdrawn where one stands (GRA-295). Nothing here records a new
 * integration or build approval, which only an answer does.
 */
export function ChangeAnswerDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  title,
  targets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  title: string;
  targets: ChangeTargets;
}) {
  const queryClient = useQueryClient();
  const tools = useQuery({ ...approvalsQuery(agentId), enabled: open && targets.tool !== null });
  // The tool as it runs now: its version and annotations decide the line, never the ask's.
  const toolbox = useQuery({ ...toolsQuery, enabled: open && targets.tool !== null });
  const vendors = useQuery({
    ...vendorApprovalsQuery(agentId),
    enabled: open && targets.vendor !== null,
  });
  const builds = useQuery({
    ...buildApprovalsQuery(agentId),
    enabled: open && targets.buildConnectionId !== null,
  });
  const reads = [
    targets.tool ? tools : null,
    targets.tool ? toolbox : null,
    targets.vendor ? vendors : null,
    targets.buildConnectionId ? builds : null,
  ].filter((read) => read !== null);
  const pending = reads.some((read) => read.isPending);
  const failed = reads.find((read) => read.isError);

  const settled = (message: string, description: string) => {
    void queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(agentId) });
    void queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(agentId) });
    void queryClient.invalidateQueries({ queryKey: approvalKeys.buildsOfAgent(agentId) });
    // A tool's answer set here answers the open asks it settles (`setApprovalFromConsole`).
    void queryClient.invalidateQueries({ queryKey: pendingKeys.all });
    toast.success(message, { description });
  };

  const decide = useMutation({
    mutationFn: ({ toolId, decision }: { toolId: string; decision: "allow" | "deny" }) =>
      setApprovalDecision(agentId, toolId, decision),
    onSuccess: (_result, { decision }) =>
      settled(
        decision === "allow" ? "Allowed" : "Denied",
        decision === "allow"
          ? `${agentName} runs it without asking.`
          : `${agentName}'s calls to it are refused.`,
      ),
  });
  const everyCall = useMutation({
    mutationFn: ({ toolId, on }: { toolId: string; on: boolean }) =>
      setApprovalAskEveryCall(agentId, toolId, on),
    onSuccess: (_result, { on }) =>
      settled(
        on ? "Asks every time" : "Answer holds",
        on ? "It asks you before each call." : "Its next calls pass without asking.",
      ),
  });
  const withdrawTool = useMutation({
    mutationFn: (toolId: string) => withdrawApproval(agentId, toolId),
    onSuccess: () => settled("Withdrawn", "The tool asks again on its next call."),
  });
  const widen = useMutation({
    mutationFn: ({ vendor, on }: { vendor: string; on: boolean }) =>
      setVendorApprovalDestructive(agentId, vendor, on),
    onSuccess: (_result, { on }) =>
      settled(
        on ? "Includes ones that delete" : "Except ones that delete",
        on
          ? "Tools that can delete or overwrite data run without asking too."
          : "Tools that can delete or overwrite data ask you first.",
      ),
  });
  const withdrawVendor = useMutation({
    mutationFn: (vendor: string) => withdrawVendorApproval(agentId, vendor),
    onSuccess: () => settled("Withdrawn", "Its tools ask again, each once."),
  });
  const withdrawBuild = useMutation({
    mutationFn: (connectionId: string) => withdrawBuildApproval(agentId, connectionId),
    onSuccess: () => settled("Withdrawn", `${agentName} asks before it builds again.`),
  });
  const busy = [decide, everyCall, withdrawTool, widen, withdrawVendor, withdrawBuild].some(
    (mutation) => mutation.isPending,
  );

  const vendor = targets.vendor
    ? standingVendor(vendors.data?.vendorApprovals ?? [], targets.vendor.slug)
    : null;
  const current = targets.tool
    ? (toolbox.data?.tools.find((candidate) => candidate.id === targets.tool?.toolId) ?? null)
    : null;
  const tool = targets.tool
    ? standingTool(
        tools.data?.approvals ?? [],
        targets.tool.toolId,
        current?.currentVersionId ?? null,
      )
    : null;
  const view = targets.tool ? toolChangeView(current, tool, vendor) : null;
  const build = targets.buildConnectionId
    ? standingBuild(builds.data?.buildApprovals ?? [], targets.buildConnectionId)
    : false;
  const nothing = !targets.tool && !vendor && !build;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8">{title}</DialogTitle>
          <DialogDescription>
            What stands for {agentName} now, which may differ from the answer you gave then.
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : failed ? (
          <RetryNotice
            error={failed.error}
            message="What stands now could not be loaded."
            onRetry={() => {
              for (const read of reads) void read.refetch();
            }}
            retrying={reads.some((read) => read.isFetching)}
          />
        ) : nothing ? (
          <p className="text-muted-foreground text-sm">
            Nothing stands now. {agentName} asks again the next time it needs this.
          </p>
        ) : (
          <ItemGroup className="gap-2">
            {targets.tool && view ? (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>
                    {targets.tool.label}
                    {view.destructive ? <Badge variant="destructive">Can delete</Badge> : null}
                  </ItemTitle>
                  <ItemDescription>{view.sentence}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {view.allow ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        targets.tool &&
                        decide.mutate({ toolId: targets.tool.toolId, decision: "allow" })
                      }
                    >
                      Allow
                    </Button>
                  ) : null}
                  {view.deny ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        targets.tool &&
                        decide.mutate({ toolId: targets.tool.toolId, decision: "deny" })
                      }
                    >
                      Deny
                    </Button>
                  ) : null}
                  {view.withdraw ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => targets.tool && withdrawTool.mutate(targets.tool.toolId)}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            ) : null}
            {targets.tool && view?.askEveryCall != null ? (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>Ask every time</ItemTitle>
                  <ItemDescription>
                    Asks you before each call, whatever else stands.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={view.askEveryCall}
                    disabled={busy}
                    aria-label="Ask every time"
                    onCheckedChange={(on) =>
                      targets.tool && everyCall.mutate({ toolId: targets.tool.toolId, on })
                    }
                  />
                </ItemActions>
              </Item>
            ) : null}
            {targets.vendor && vendor ? (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>Every {targets.vendor.integrationName} tool</ItemTitle>
                  <ItemDescription>
                    {vendor.includesDestructive
                      ? "Including ones that delete"
                      : "Except ones that delete"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={vendor.includesDestructive}
                    disabled={busy}
                    aria-label="Include ones that delete"
                    onCheckedChange={(on) =>
                      targets.vendor && widen.mutate({ vendor: targets.vendor.slug, on })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => targets.vendor && withdrawVendor.mutate(targets.vendor.slug)}
                  >
                    Withdraw
                  </Button>
                </ItemActions>
              </Item>
            ) : null}
            {targets.buildConnectionId && build ? (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>Build its own tools</ItemTitle>
                  <ItemDescription>
                    Anything it builds still asks before changing data
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      targets.buildConnectionId && withdrawBuild.mutate(targets.buildConnectionId)
                    }
                  >
                    Withdraw
                  </Button>
                </ItemActions>
              </Item>
            ) : null}
          </ItemGroup>
        )}
      </DialogContent>
    </Dialog>
  );
}
