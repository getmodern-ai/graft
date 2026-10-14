import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useEffect, useId, useRef } from "react";

import { ArrowForwardIcon } from "@/components/icons";
import { RequestListNote } from "@/components/pending/request-row";
import { RetryNotice } from "@/components/retry-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { cn } from "@/lib/utils";

/**
 * One of Home's panels (GRA-327; the "Section header" and "List" of Figma 2040:5486): a heading
 * with an optional count, a muted sentence, the way to the whole screen on the right, and the
 * body. Each panel owns its read, so its loading, empty and failed states sit inside its own list
 * (GRA-47) and a failed read takes nothing else down.
 */
export function HomePanel({
  title,
  count,
  description,
  more,
  className,
  children,
}: {
  title: string;
  /** The number beside the heading; nothing when absent or zero. */
  count?: number;
  description: string;
  /** "See all requests" and the like: a router `Link` for `Button`'s `render`, and its words. */
  more?: { label: string; render: React.ReactElement };
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h2 id={id} className="font-heading font-medium text-lg tracking-tight">
              {title}
            </h2>
            {count ? <Badge aria-label={`${count} waiting`}>{count}</Badge> : null}
          </div>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {more ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            nativeButton={false}
            render={more.render}
          >
            {more.label}
            <ArrowForwardIcon />
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A row of a Home list: the mark, two lines, and whatever sits on the right. */
export function HomeRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <li
      className={cn(
        "flex min-h-14 items-center gap-3 border-border border-b px-5 py-3 last:border-b-0",
        className,
      )}
    >
      {children}
    </li>
  );
}

/** The two lines beside a row's mark: the name or sentence, and the muted line under it. */
export function HomeRowText({
  title,
  detail,
  detailClassName,
}: {
  title: React.ReactNode;
  detail: React.ReactNode;
  detailClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="truncate font-medium text-sm">{title}</div>
      <p className={cn("truncate text-muted-foreground text-xs", detailClassName)}>{detail}</p>
    </div>
  );
}

/** Rows at a Home list's rhythm while its read is pending. */
export function HomeListLoading({ rows = 3 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <HomeRow key={row}>
          <Skeleton className="size-5 shrink-0 rounded-sm" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </HomeRow>
      ))}
    </>
  );
}

/** A failed first read, as a row of the panel's own list with the inline Retry. */
export function HomeListFailed({
  query,
  message,
}: {
  query: { error: unknown; isFetching: boolean; refetch: () => unknown };
  message: string;
}) {
  return (
    <RequestListNote>
      <RetryNotice
        error={query.error}
        message={message}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    </RequestListNote>
  );
}

/**
 * Read a panel again whenever the set of open requests changes: an answer given on Home (which
 * refreshes the open requests and nothing else of Home's), or an ask that arrives or closes
 * elsewhere. Through the sidebar's read and poll, so the answer paths shared with Requests stay
 * as they are. The first answer of the read is no change, since the panel's read started beside it.
 */
export function useRefetchWhenRequestsChange(refetch: () => unknown) {
  const pending = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const openIds = pending.data?.pendingActions.map((action) => action.id).join(",");
  const seen = useRef(openIds);
  useEffect(() => {
    if (openIds === undefined || seen.current === openIds) return;
    const first = seen.current === undefined;
    seen.current = openIds;
    if (!first) void refetch();
  }, [openIds, refetch]);
}
