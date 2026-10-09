import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { AddIcon, InfoIcon, KeyboardArrowDownIcon, SearchIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { SetupChoice, type SetupChoiceOption } from "@/components/setup/setup-choice";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingKeys } from "@/lib/pending-action-queries";
import {
  chooseSetupStarter,
  connectSetup,
  type DirectoryEntry,
  type DirectoryHome,
  type SetupStateData,
  setupDirectoryHomeQuery,
  setupDirectorySearchQuery,
  setupGoalQuery,
} from "@/lib/setup-queries";
import { ANOTHER_VENDOR, choiceLeavesJob } from "@/lib/setup-vendors";
import { cn } from "@/lib/utils";

/** How long the search waits after the last keystroke before it asks. */
const SEARCH_DEBOUNCE_MS = 300;
/** How many category chips show before *N more*. */
const CHIPS_SHOWN = 8;

/** What a card says about connecting it, in the footer beside its name. */
const CONNECT_LABEL: Record<DirectoryEntry["connect"], string> = {
  link: "One click",
  keyless: "No key needed",
  form: "You enter its key",
};

/**
 * Setup v2's integration step body (the frames' *2 App*): the directory this deployment searches
 * (`GET /api/setup/directory`, the private package's or the starters'), drawn as the frames draw it.
 * A search box; before any search, the logo wall and *Popular* with the category chips; a search or
 * a chip lists what matches, a page at a time. Every grid ends on *Another integration*, the
 * ordinary form for any API with a key in hand.
 *
 * Continue on a starter saves it (`POST /api/setup/starter`) and the tool screen follows from the
 * record; on another directory integration it hands the entry to the step (`onChooseApp`), whose
 * tool screen connects it with the task; on *Another integration* it opens the form, and the
 * connection it makes is taken on by the record as before (GRA-206). That connection's id is kept,
 * so a handoff that fails after the form closed is tried again with it.
 */
export function VendorChoice({
  state,
  onChooseApp,
}: {
  state: SetupStateData;
  onChooseApp: (entry: DirectoryEntry) => void;
}) {
  const home = useQuery(setupDirectoryHomeQuery);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [allChips, setAllChips] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const searching = query !== "" || category !== null;
  const search = useInfiniteQuery({
    ...setupDirectorySearchQuery(query, category),
    enabled: searching,
  });

  const holds = state.setup?.connectionId != null;
  const goal = useQuery({ ...setupGoalQuery, enabled: holds });
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<DirectoryEntry | typeof ANOTHER_VENDOR | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [madeConnectionId, setMadeConnectionId] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const connect = useSetupMutation(connectSetup);
  const choose = useSetupMutation(chooseSetupStarter);
  const busy = connect.isPending || choose.isPending;
  const handOff = (connectionId: string) =>
    connect.mutate(
      { connectionId, ...(discard ? { discardJob: true } : {}) },
      {
        onSuccess: () => {
          setMadeConnectionId(null);
          setConfirming(false);
          void queryClient.invalidateQueries({ queryKey: pendingKeys.all });
        },
      },
    );

  const go = (discardJob: boolean) => {
    if (!picked) return;
    if (picked === ANOTHER_VENDOR) {
      setDiscard(discardJob);
      setConfirming(false);
      if (madeConnectionId) handOff(madeConnectionId);
      else setFormOpen(true);
    } else if (picked.starterId) {
      choose.mutate({ starterId: picked.starterId });
    } else {
      onChooseApp(picked);
    }
  };

  const entries: DirectoryEntry[] = searching
    ? (search.data?.pages.flatMap((page) => page.entries) ?? [])
    : (home.data?.popular ?? []);
  const total = searching ? (search.data?.pages[0]?.total ?? 0) : (home.data?.total ?? 0);
  const options: SetupChoiceOption<string>[] = [
    ...entries.map((entry) => ({
      value: entry.slug,
      label: entry.name,
      description: entry.description ? (
        <span className="line-clamp-2">{entry.description}</span>
      ) : undefined,
      media: <SetupLogo starterId={entry.starterId} url={entry.logoUrl} />,
    })),
    {
      value: ANOTHER_VENDOR,
      label: "Anything else",
      description: "Any service with an API: its address, how it signs in and its key.",
      media: (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background"
        >
          <AddIcon className="size-5" />
        </span>
      ),
      aside: <Badge variant="outline">Any API</Badge>,
      dashed: true,
    },
  ];
  const chosenValue = picked === ANOTHER_VENDOR ? ANOTHER_VENDOR : (picked?.slug ?? null);
  const held = goal.data
    ? { starterId: goal.data.starterId, jobStatus: goal.data.job?.status ?? null }
    : null;
  const loading = searching ? search.isPending : home.isPending;
  const failed = searching ? search.isError : home.isError;

  return (
    <>
      <form
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!picked) return;
          if (picked === ANOTHER_VENDOR && choiceLeavesJob(ANOTHER_VENDOR, held)) {
            setConfirming(true);
          } else go(false);
        }}
      >
        <div className="mx-auto flex w-full max-w-[720px] items-center gap-2 rounded-lg border bg-background px-3 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search integrations"
            placeholder={
              home.data && home.data.total > home.data.popular.length
                ? `Search ${home.data.total.toLocaleString("en")} integrations`
                : "Search integrations"
            }
            className="h-11 border-0 bg-transparent shadow-none focus-visible:ring-0"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        {!searching && home.data ? <LogoWall home={home.data} /> : null}

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-medium text-base">
              {query
                ? `${total.toLocaleString("en")} ${total === 1 ? "integration matches" : "integrations match"} “${query}”`
                : (category ?? "Popular")}
            </h2>
            <span className="text-muted-foreground text-sm">
              {searching
                ? category && !query
                  ? `${total.toLocaleString("en")} in the directory · the most connected first`
                  : "The most connected first"
                : "Most connected by Graft users"}
            </span>
          </div>
          {home.data && home.data.categories.length > 0 && !query ? (
            <div className="flex flex-wrap items-center gap-1">
              <Chip active={category === null} onClick={() => setCategory(null)}>
                All
              </Chip>
              {(allChips ? home.data.categories : home.data.categories.slice(0, CHIPS_SHOWN)).map(
                (chip) => (
                  <Chip
                    key={chip.name}
                    active={category === chip.name}
                    onClick={() => setCategory(chip.name)}
                  >
                    {chip.name}
                  </Chip>
                ),
              )}
              {!allChips && home.data.categories.length > CHIPS_SHOWN ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setAllChips(true)}>
                  <KeyboardArrowDownIcon />
                  {home.data.categories.length - CHIPS_SHOWN} more
                </Button>
              ) : null}
            </div>
          ) : null}

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
              {["a", "b", "c", "d"].map((key) => (
                <Skeleton key={key} className="h-36 rounded-lg" />
              ))}
            </div>
          ) : failed ? (
            <p className="text-muted-foreground text-sm">
              <RetryNotice
                error={searching ? search.error : home.error}
                message="Could not load the integrations."
                onRetry={() => void (searching ? search.refetch() : home.refetch())}
                retrying={searching ? search.isFetching : home.isFetching}
              />
            </p>
          ) : (
            <SetupChoice
              name="setup-vendor"
              legend="Integration"
              layout="stack"
              options={options}
              value={chosenValue}
              onChange={(value) =>
                setPicked(
                  value === ANOTHER_VENDOR
                    ? ANOTHER_VENDOR
                    : (entries.find((entry) => entry.slug === value) ?? null),
                )
              }
              disabled={busy}
            />
          )}
          {searching && search.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              className="self-center"
              disabled={search.isFetchingNextPage}
              onClick={() => void search.fetchNextPage()}
            >
              <KeyboardArrowDownIcon />
              {search.isFetchingNextPage
                ? "Loading…"
                : `Show more of ${total.toLocaleString("en")}`}
            </Button>
          ) : null}
        </div>

        <SetupFooter
          state={state}
          disabled={busy}
          summary={
            picked && picked !== ANOTHER_VENDOR ? (
              <>
                <SetupLogo
                  starterId={picked.starterId}
                  url={picked.logoUrl}
                  tile={false}
                  className="size-5"
                />
                <span className="font-medium text-foreground">{picked.name}</span>
                <span>· {CONNECT_LABEL[picked.connect]}</span>
              </>
            ) : picked === ANOTHER_VENDOR ? (
              <>
                <AddIcon className="size-4 shrink-0" />
                <span className="font-medium text-foreground">Anything else</span>
                <span>· You enter its key next</span>
              </>
            ) : (
              <>
                <InfoIcon className="size-4 shrink-0" />
                Pick one integration, or any service with an API
              </>
            )
          }
        >
          <Button type="submit" disabled={!picked || busy}>
            {busy ? "Continuing…" : "Continue"}
          </Button>
        </SetupFooter>
      </form>
      {madeConnectionId && connect.isError && picked === ANOTHER_VENDOR ? (
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={connect.error}
            message="Your connection was made, but Setup could not take it on."
            onRetry={() => handOff(madeConnectionId)}
            retrying={connect.isPending}
          />
        </p>
      ) : null}
      <DiscardJobDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => go(true)}
        pending={connect.isPending}
        action={{ label: "Choose it anyway", pending: "Connecting…" }}
        consequence="Choosing another integration starts over from its connection."
      />
      <AddConnectionDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onConnected={(connectionId) => {
          setMadeConnectionId(connectionId);
          handOff(connectionId);
        }}
      />
    </>
  );
}

/** A category chip: the frames' `Category chip`, outline, the chosen one in the primary's border. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={active}
      className={cn("rounded-full", active ? "border-primary bg-primary/5" : null)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * The frames' logo wall: two rows of 48px tiles with the directory's next most connected marks,
 * fading at either end, and the line under it saying how many more there are.
 */
function LogoWall({ home }: { home: DirectoryHome }) {
  if (home.wall.length === 0) return null;
  const half = Math.ceil(home.wall.length / 2);
  const rows = [home.wall.slice(0, half), home.wall.slice(half)];
  const more = home.total - home.popular.length - home.wall.length;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex w-full flex-col items-center gap-3 overflow-hidden">
        {rows.map((row, index) => (
          <ul key={index === 0 ? "first" : "second"} className="flex gap-3">
            {row.map((mark) => (
              <li
                key={mark.slug}
                title={mark.name}
                className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-card"
              >
                <img
                  alt={mark.name}
                  src={mark.logoUrl ?? undefined}
                  className="size-7 rounded-md object-contain"
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
        ))}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-linear-to-r from-background to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-linear-to-l from-background to-transparent" />
      </div>
      <p className="text-muted-foreground text-sm">
        {more > 0 ? (
          <>
            <span className="font-medium text-foreground">
              +{more.toLocaleString("en")} more in the directory
            </span>{" "}
            · and anything with an API
          </>
        ) : (
          "And anything with an API"
        )}
      </p>
    </div>
  );
}
