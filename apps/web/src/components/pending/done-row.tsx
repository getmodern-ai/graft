import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { IntegrationHarnessMark } from "@/components/marks";
import { ChangeAnswerDialog } from "@/components/pending/change-answer-dialog";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { HarnessMarkId } from "@/lib/marks";
import { changeDialogTitle, type DoneRequest, doneRowCopy, doneRowWhen } from "@/lib/request-done";
import { requestAgentName } from "@/lib/request-row";
import { cachedDirectoryLogo } from "@/lib/setup-queries";

/**
 * One finished request as a row of Requests > Done (GRA-312; the Figma frame "03b Requests >
 * Done"): the open row's mark and rhythm (`request-row.tsx`), the sentence saying what happened,
 * and Change where `doneRowCopy` found something standing that a route can change.
 */
export function DoneRow({
  card,
  harness,
  agentActive,
}: {
  card: DoneRequest;
  harness: HarnessMarkId;
  agentActive: boolean;
}) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const copy = doneRowCopy(card, agentActive);
  const when = doneRowWhen(card, copy.detail === null);

  return (
    <li className="flex flex-wrap items-center gap-3 border-border border-b px-5 py-2.5 last:border-b-0">
      <IntegrationHarnessMark
        slug={copy.vendor}
        name={copy.integrationName}
        logoUrl={copy.vendor ? cachedDirectoryLogo(queryClient, copy.vendor) : null}
        harness={harness}
      />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="font-medium text-base text-foreground">{copy.title}</p>
        <p className="text-muted-foreground text-xs">
          {copy.detail}
          {copy.detail && when ? " · " : null}
          {when ? (
            <time dateTime={when.iso} title={formatDateTime(when.iso)}>
              {when.label}
            </time>
          ) : null}
        </p>
      </div>
      {copy.change ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setChanging(true)}
          >
            Change
          </Button>
          <ChangeAnswerDialog
            open={changing}
            onOpenChange={setChanging}
            agentId={card.agentId}
            agentName={requestAgentName(card)}
            title={changeDialogTitle(requestAgentName(card), copy.integrationName)}
            targets={copy.change}
          />
        </>
      ) : null}
    </li>
  );
}
