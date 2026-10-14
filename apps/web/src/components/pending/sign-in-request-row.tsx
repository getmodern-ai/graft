import { useQueryClient } from "@tanstack/react-query";

import { SignInButton } from "@/components/integration/sign-in-button";
import { IntegrationHarnessMark } from "@/components/marks";
import { formatDateTime } from "@/lib/format";
import { harnessMark } from "@/lib/marks";
import { cachedDirectoryLogo } from "@/lib/setup-queries";
import { type SignInRequest, signInRequestWhen } from "@/lib/sign-in-requests";

/**
 * A connection that needs the person, as a row of `RequestList` (GRA-313; Figma 2075:8068), drawn
 * to `RequestRow`'s measure so Open reads as one list. The words are `lib/sign-in-requests.ts`'s;
 * Sign in is the integrations table's (`SignInButton`), the connection's own way in. There is no
 * decline: it is a connection state, not an ask (GRA-287 item 7).
 */
export function SignInRequestRow({ request }: { request: SignInRequest }) {
  const queryClient = useQueryClient();
  const when = signInRequestWhen(request);

  return (
    <li className="flex flex-wrap items-center gap-3 border-border border-b px-5 py-2.5 last:border-b-0">
      <IntegrationHarnessMark
        slug={request.vendor}
        name={request.integrationName}
        logoUrl={cachedDirectoryLogo(queryClient, request.vendor)}
        harness={harnessMark(request.harness)}
      />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="font-medium text-base text-foreground">{request.title}</p>
        <p className="text-muted-foreground text-xs">
          {request.detail}
          {when ? (
            <>
              {" · "}
              <time dateTime={when.iso} title={formatDateTime(when.iso)}>
                {when.label}
              </time>
            </>
          ) : null}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SignInButton
          connection={request.connection}
          kind={request.action.kind}
          variant="default"
        />
      </div>
    </li>
  );
}
