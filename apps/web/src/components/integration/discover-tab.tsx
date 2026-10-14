import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import {
  AddIcon,
  ArrowForwardIcon,
  ExtensionIcon,
  KeyboardArrowDownIcon,
  SearchIcon,
} from "@/components/icons";
import { CategoryChips } from "@/components/integration/category-chips";
import {
  type ConnectForm,
  ConnectIntegrationDialog,
  type ConnectTarget,
} from "@/components/integration/connect-integration-dialog";
import { IntegrationTile, IntegrationTileGrid } from "@/components/integration/integration-tile";
import { RetryNotice } from "@/components/retry-notice";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { draftFromProposal, emptyDraft } from "@/lib/connection-form";
import {
  integrationDirectoryHomeQuery,
  integrationDirectorySearchQuery,
  integrationsQuery,
  type SuggestedIntegration,
  suggestedIntegrationsQuery,
} from "@/lib/integration-queries";
import {
  connectedVendors,
  customApiSeed,
  discoverPlaceholder,
  readDiscoverSearch,
  resultsHeading,
  suggestionConnect,
  suggestionCustom,
  suggestionLine,
} from "@/lib/integrations-discover";
import { suggestedVendorsOf } from "@/lib/integrations-list";
import type { DirectoryEntry } from "@/lib/setup-queries";

/** How long the search waits after the last keystroke before it asks. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The Integrations screen's Discover tab (GRA-322; Figma 2043:7028, no results 2118:14864): the
 * integration directory outside Setup (GRA-305; ADR 0001 as amended 2026-10-14). A search box over
 * the directory, the category chips when the backing has categories (the starters have none, so
 * the open form draws no chips), *Suggested for your agents* from the person's own connection asks,
 * *Popular* in the backing's own order, and *Add a custom API* for anything else.
 *
 * A tile's Connect is the connect dialog (`POST /api/connect`, GRA-304). A docs link pasted into the
 * search, *Add a custom API* and a search that finds nothing hand off to Flow C (GRA-323) through
 * the screen's `custom` param, which `customApiSeed` reads; until Flow C's dialogs land, `custom`
 * opens the ordinary form with the name filled in.
 */
export function DiscoverTab({ q, custom }: { q?: string; custom?: string }) {
  const navigate = useNavigate();
  const home = useQuery(integrationDirectoryHomeQuery);
  const integrations = useQuery(integrationsQuery);
  const suggestions = useQuery(suggestedIntegrationsQuery);
  const [typed, setTyped] = useState(q ?? "");
  const [query, setQuery] = useState((q ?? "").trim());
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const intent = readDiscoverSearch(typed);
  const words = intent.kind === "search" ? query : "";
  const searching = words !== "" || category !== null;
  const grid = useInfiniteQuery({
    ...integrationDirectorySearchQuery(words, category),
    enabled: intent.kind !== "docs",
  });

  const [target, setTarget] = useState<ConnectTarget | null>(null);
  const [form, setForm] = useState<{ form: ConnectForm; name: string } | null>(null);

  const handOff = (text: string) =>
    void navigate({
      to: "/integrations",
      // `q` is kept, so the tab (keyed by it) is not drawn afresh under the dialog.
      search: { tab: "discover", ...(q ? { q } : {}), custom: text },
    });
  const connected = connectedVendors(integrations.data?.integrations ?? []);
  // A failed suggestions read hides the section: it is a nudge, never what the tab is for.
  const suggested = suggestedVendorsOf(
    suggestions.data?.suggestions ?? [],
    integrations.data?.integrations ?? [],
  );
  const entries = grid.data?.pages.flatMap((page) => page.entries) ?? [];
  const total = grid.data?.pages[0]?.total ?? 0;
  const categories = home.data?.categories ?? [];
  const noResults = grid.isSuccess && entries.length === 0 && words !== "";

  return (
    <>
      <div className="flex flex-col gap-4">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search integrations"
            placeholder={discoverPlaceholder(home.data?.total)}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              // A text search searches everything, as Setup's does (Greptile on #201).
              if (event.target.value.trim()) setCategory(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && intent.kind === "docs") handOff(intent.url);
            }}
          />
        </InputGroup>
        {categories.length > 0 && intent.kind !== "search" ? (
          <CategoryChips
            categories={categories}
            value={category}
            onChange={setCategory}
            allCount={home.data?.total}
          />
        ) : null}
      </div>

      {intent.kind === "docs" ? (
        <DocsHandOff url={intent.url} onAdd={() => handOff(intent.url)} />
      ) : (
        <>
          {!searching && suggested.length > 0 ? (
            <Section
              title="Suggested for your agents"
              description="Integrations your agents asked to connect."
            >
              <IntegrationTileGrid>
                {suggested.map((suggestion) => (
                  <SuggestionTile
                    key={suggestion.vendor}
                    suggestion={suggestion}
                    onConnect={() =>
                      setTarget({
                        slug: suggestion.vendor,
                        name: suggestion.displayName,
                        logoUrl: suggestion.logoUrl,
                        connect: null,
                      })
                    }
                  />
                ))}
              </IntegrationTileGrid>
            </Section>
          ) : null}

          <Section
            // No results says so in its own words (Figma 2118:14864), under no "0 match" heading.
            title={noResults ? null : resultsHeading(words, category, total)}
            description={
              searching
                ? undefined
                : "A place to start. Search for any other, or add one by its API docs."
            }
          >
            {grid.isPending ? (
              <IntegrationTileGrid>
                {["a", "b", "c", "d"].map((key) => (
                  <li key={key}>
                    <Skeleton className="h-32 rounded-lg" />
                  </li>
                ))}
              </IntegrationTileGrid>
            ) : grid.isError ? (
              <RetryNotice
                error={grid.error}
                message="Could not load the integrations."
                onRetry={() => void grid.refetch()}
                retrying={grid.isFetching}
              />
            ) : noResults ? (
              <NoResults name={words} onAdd={() => handOff(words)} />
            ) : entries.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing in this category yet.</p>
            ) : (
              <IntegrationTileGrid>
                {entries.map((entry) => (
                  <EntryTile
                    key={entry.slug}
                    entry={entry}
                    connected={connected.has(entry.slug)}
                    onConnect={() => setTarget(entry)}
                  />
                ))}
              </IntegrationTileGrid>
            )}
            {grid.hasNextPage ? (
              <Button
                type="button"
                variant="ghost"
                className="self-center"
                disabled={grid.isFetchingNextPage}
                onClick={() => void grid.fetchNextPage()}
              >
                <KeyboardArrowDownIcon />
                {grid.isFetchingNextPage
                  ? "Loading…"
                  : `Show more of ${total.toLocaleString("en")}`}
              </Button>
            ) : null}
          </Section>

          {noResults ? null : <CustomApiBanner onAdd={() => handOff(words || typed.trim())} />}
        </>
      )}

      <ConnectIntegrationDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onForm={(answer, name) => setForm({ form: answer, name })}
        onNotFound={(missing) => {
          const suggestion = suggested.find((each) => each.vendor === missing.slug);
          handOff(suggestion ? suggestionCustom(suggestion) : missing.name);
        }}
      />
      <AddConnectionDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        title={form ? `Connect ${form.name}` : undefined}
        initialDraft={form ? draftFromProposal(form.form.proposal) : undefined}
        access={form?.form.access}
        onConnected={(_, vendor) => {
          setForm(null);
          // The saved vendor, not the proposal's: the person may have edited the slug.
          void navigate({ to: "/integrations/$vendor", params: { vendor } });
        }}
      />
      <CustomApiFallback
        custom={custom}
        onClose={() =>
          void navigate({ to: "/integrations", search: { tab: "discover", ...(q ? { q } : {}) } })
        }
      />
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string | null;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      {title ? (
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium text-base">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function EntryTile({
  entry,
  connected,
  onConnect,
}: {
  entry: DirectoryEntry;
  connected: boolean;
  onConnect: () => void;
}) {
  return (
    <IntegrationTile
      slug={entry.starterId ?? entry.slug}
      name={entry.name}
      logoUrl={entry.logoUrl}
      subline={entry.description}
      action={
        connected ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/integrations/$vendor" params={{ vendor: entry.slug }} />}
          >
            Open
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onConnect}>
            <AddIcon />
            Connect
          </Button>
        )
      }
    />
  );
}

/**
 * A suggestion's tile. An open ask is answered on its request, where the agent waiting on it hears
 * the answer; a closed one connects as any tile does (`suggestionConnect`).
 */
function SuggestionTile({
  suggestion,
  onConnect,
}: {
  suggestion: SuggestedIntegration;
  onConnect: () => void;
}) {
  const connect = suggestionConnect(suggestion);
  return (
    <IntegrationTile
      slug={suggestion.vendor}
      name={suggestion.displayName}
      logoUrl={suggestion.logoUrl}
      subline={suggestionLine(suggestion)}
      action={
        connect.kind === "request" ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/pending/$id" params={{ id: connect.pendingActionId }} />}
          >
            <AddIcon />
            Connect
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onConnect}>
            <AddIcon />
            Connect
          </Button>
        )
      }
    />
  );
}

/** The frame's closing band: anything with an API, by its docs. */
function CustomApiBanner({ onAdd }: { onAdd: () => void }) {
  return (
    <Item variant="outline" className="gap-4 bg-muted/50 px-5 py-4 md:px-6 md:py-5">
      <span className="hidden size-10 shrink-0 items-center justify-center rounded-md border bg-card sm:flex">
        <ExtensionIcon className="size-5" />
      </span>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="line-clamp-none text-base">
          Don't see your integration? Anything with an API works.
        </ItemTitle>
        <ItemDescription className="text-sm">
          Paste a link to its API docs and Graft sets it up for you to check.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button onClick={onAdd}>
          <AddIcon />
          Add a custom API
        </Button>
      </ItemActions>
    </Item>
  );
}

/** A docs link in the search box: Discover searches nothing and offers Flow C with it. */
function DocsHandOff({ url, onAdd }: { url: string; onAdd: () => void }) {
  return (
    <Item variant="outline" className="gap-4 px-5 py-4">
      <span className="hidden size-10 shrink-0 items-center justify-center rounded-md border bg-card sm:flex">
        <ExtensionIcon className="size-5" />
      </span>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle>Add an integration from its API docs</ItemTitle>
        <ItemDescription className="break-all">{url}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button onClick={onAdd}>
          Continue
          <ArrowForwardIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}

/** No results (Figma 2118:14864): the typed name, carried into Flow C. */
function NoResults({ name, onAdd }: { name: string; onAdd: () => void }) {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-10 border bg-card">
          <ExtensionIcon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>No integration called “{name}” yet</EmptyTitle>
        <EmptyDescription>
          Graft can still connect it. Anything with an API works: Graft reads its docs and sets it
          up for you to check.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAdd}>
          <AddIcon />
          Add a custom API
        </Button>
        <p className="text-muted-foreground text-xs">
          You check everything before anything connects.
        </p>
      </EmptyContent>
    </Empty>
  );
}

/**
 * Until Flow C's dialogs land (GRA-323), `custom` opens the ordinary form with the typed name in
 * it, so every hand-off above reaches a way to connect. GRA-323 replaces this with its own dialog,
 * reading the same param through `customApiSeed`.
 */
function CustomApiFallback({ custom, onClose }: { custom?: string; onClose: () => void }) {
  const seed = custom !== undefined ? customApiSeed(custom) : null;
  return (
    <AddConnectionDialog
      open={seed !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      initialDraft={seed ? { ...emptyDraft(), displayName: seed.name } : undefined}
    />
  );
}
