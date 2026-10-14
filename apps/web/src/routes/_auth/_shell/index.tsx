import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { useScreenTitle } from "@/components/shell/screen-title";
import { homeGreeting } from "@/lib/home-greeting";
import { sessionQuery } from "@/lib/session-queries";

/**
 * Home, at `/`, where a signed-in person lands (`DEFAULT_SIGNED_IN_PATH`). A placeholder until
 * GRA-327 builds the Figma "App v2" Home: the greeting, and a sentence pointing at the three
 * screens Home will summarise. Replace this file's body, not its route.
 */
export const Route = createFileRoute("/_auth/_shell/")({
  component: HomeRoute,
});

function HomeRoute() {
  useScreenTitle("Home");
  // The guard's cached read, so the name is there on the first paint rather than a beat after.
  const { data: session } = useQuery(sessionQuery);

  return (
    <PageContainer size="medium" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{homeGreeting(new Date(), session?.user.name)}</PageHeaderTitle>
          <PageHeaderDescription>
            Answer what your agents are waiting on in{" "}
            <Link to="/pending" className="underline underline-offset-4">
              Requests
            </Link>
            , see where Graft is in use in{" "}
            <Link to="/agents" className="underline underline-offset-4">
              Agents
            </Link>
            , and see what your agents can reach in{" "}
            <Link to="/connections" className="underline underline-offset-4">
              Integrations
            </Link>
            .
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
    </PageContainer>
  );
}
