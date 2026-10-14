import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  HomeListFailed,
  HomeListLoading,
  HomePanel,
  HomeRow,
  HomeRowText,
} from "@/components/home/home-panel";
import { SignInButton } from "@/components/integration/integrations-table";
import { IntegrationMark } from "@/components/marks";
import { RequestList, RequestListNote } from "@/components/pending/request-row";
import { homeIntegrations, integrationUsageLine } from "@/lib/home";
import { type Integration, integrationsQuery } from "@/lib/integration-queries";
import { attentionSentence, signInOf } from "@/lib/integrations-list";
import { cn } from "@/lib/utils";

/**
 * *Connected integrations* (GRA-327): the integrations read (GRA-291) in the Integrations screen's
 * order, one that needs the person first with the Connected tab's red line and Sign in
 * (`signInOf`, `SignInButton`), the rest with their tools and who uses them.
 */
export function IntegrationsPanel() {
  const integrations = useQuery(integrationsQuery);
  const { shown } = homeIntegrations(integrations.data?.integrations ?? []);

  return (
    <HomePanel
      title="Connected integrations"
      description="Your agents use these. They never see your passwords."
      more={{ label: "All integrations", render: <Link to="/integrations" /> }}
    >
      <RequestList aria-label="Connected integrations" aria-busy={integrations.isPending}>
        {integrations.isPending ? (
          <HomeListLoading />
        ) : integrations.isError && !integrations.data ? (
          <HomeListFailed query={integrations} message="Could not load your integrations." />
        ) : shown.length === 0 ? (
          <RequestListNote>
            Nothing connected yet.{" "}
            <Link
              to="/integrations"
              search={{ tab: "discover" }}
              className="underline underline-offset-4"
            >
              Connect an integration
            </Link>
          </RequestListNote>
        ) : (
          shown.map((row) => <IntegrationRow key={row.vendor} row={row} />)
        )}
      </RequestList>
    </HomePanel>
  );
}

function IntegrationRow({ row }: { row: Integration }) {
  const attention = attentionSentence(row);
  const signIn = signInOf(row);
  return (
    <HomeRow>
      <IntegrationMark slug={row.vendor} name={row.displayName} tile="none" className="size-5" />
      <HomeRowText
        title={
          <Link
            to="/integrations/$vendor"
            params={{ vendor: row.vendor }}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {row.displayName}
          </Link>
        }
        detail={attention ?? integrationUsageLine(row)}
        detailClassName={cn(attention && "text-destructive")}
      />
      {signIn ? <SignInButton connection={signIn.connection} kind={signIn.action.kind} /> : null}
    </HomeRow>
  );
}
