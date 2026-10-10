import {
  DIRECTORY_PAGE_LIMIT,
  type DirectoryConnectKind,
  type DirectoryEntry,
  type DirectoryHome,
  type DirectoryPage,
  type DirectorySearchInput,
  type IntegrationDirectory,
  isStarterVendorId,
  type SetupVendorOption,
  type StarterVendorId,
  starterVendorFor,
} from "@graft/core";

/**
 * Setup v2's integration directory on the server (ADR 0001 as amended 2026-10-10; `@graft/core`'s
 * `IntegrationDirectory`). The backing is the private package's when it has one; otherwise the
 * **starter directory** below, the open form's: the starter integrations this deployment connects
 * in one click (`listSetupVendors`), searchable by name, with no categories. A self-host gets the
 * same screen with its starters and *Another integration*.
 *
 * The console's entries carry `starterId` beside the directory's fields: an entry that is a starter
 * integration (by vendor slug) takes the starter's path, its curated tasks and its proposal, and
 * every other entry is connected from its own fields.
 */

export type SetupDirectoryEntry = DirectoryEntry & { starterId: StarterVendorId | null };

export type SetupDirectoryHome = Omit<DirectoryHome, "popular"> & {
  popular: SetupDirectoryEntry[];
  /** The backing's name, so the console can say whose directory it is searching. */
  source: string;
};

export type SetupDirectoryPage = Omit<DirectoryPage, "entries"> & {
  entries: SetupDirectoryEntry[];
};

/** How many entries the grid shows under *Popular*: seven, and *Anything else* makes the frames' eight. */
export const DIRECTORY_POPULAR_COUNT = 7;
/** How many marks the logo wall shows. */
export const DIRECTORY_WALL_COUNT = 36;

export function withStarter(entry: DirectoryEntry): SetupDirectoryEntry {
  const starter = starterVendorFor(entry.slug);
  return {
    ...entry,
    starterId: starter && isStarterVendorId(starter.id) ? starter.id : null,
  };
}

const CONNECT_KIND: Record<SetupVendorOption["connect"], DirectoryConnectKind> = {
  link: "link",
  none: "link",
  keyless: "keyless",
};

function starterEntry(option: SetupVendorOption): DirectoryEntry {
  const { starter } = option;
  return {
    slug: starter.vendor,
    name: starter.displayName,
    description: starter.outcome,
    logoUrl: null,
    categories: [],
    hosts: [...starter.hosts],
    docsUrl: starter.docsUrl,
    connect: CONNECT_KIND[option.connect],
    scheme: starter.scheme,
  };
}

function matches(entry: DirectoryEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${entry.name} ${entry.slug} ${entry.description ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The open form's directory: the starters `options` answers, read on every call since coverage is
 * the providers' and may change with a provider's catalogue. Pages by offset, the cursor being the
 * offset as a decimal string.
 */
export function createStarterDirectory(
  options: () => Promise<SetupVendorOption[]>,
): IntegrationDirectory {
  const entries = async () => (await options()).map(starterEntry);
  return {
    name: "starters",
    async home() {
      const all = await entries();
      return { total: all.length, categories: [], popular: all, wall: [] };
    },
    async search(input: DirectorySearchInput) {
      const query = input.query?.trim() ?? "";
      const found = (await entries()).filter((entry) => !query || matches(entry, query));
      const offset = Number.parseInt(input.cursor ?? "0", 10) || 0;
      const limit = Math.min(input.limit, DIRECTORY_PAGE_LIMIT);
      const page = found.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        entries: page,
        nextCursor: next < found.length ? String(next) : null,
        total: found.length,
      };
    },
    async get(slug: string) {
      return (await entries()).find((entry) => entry.slug === slug) ?? null;
    },
  };
}

/** The integration step's first view, as the console reads it (`GET /api/setup/directory`). */
export async function setupDirectoryHome(
  directory: IntegrationDirectory,
): Promise<SetupDirectoryHome> {
  const home = await directory.home();
  return {
    total: home.total,
    categories: home.categories,
    popular: home.popular.slice(0, DIRECTORY_POPULAR_COUNT).map(withStarter),
    wall: home.wall.filter((mark) => mark.logoUrl).slice(0, DIRECTORY_WALL_COUNT),
    source: directory.name,
  };
}

/** A search, as the console reads it (`GET /api/setup/directory/search`). */
export async function searchSetupDirectory(
  directory: IntegrationDirectory,
  input: DirectorySearchInput,
): Promise<SetupDirectoryPage> {
  const page = await directory.search({
    ...input,
    limit: Math.min(Math.max(input.limit, 1), DIRECTORY_PAGE_LIMIT),
  });
  return { ...page, entries: page.entries.map(withStarter) };
}

/**
 * The connection proposal an entry makes, as `request_connection` would send it: the slug as the
 * vendor, the first host as the primary (`https://<host>`), the backing's scheme for the form path,
 * and the documentation when the backing knows it.
 */
export function directoryProposal(entry: DirectoryEntry): {
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts: string[];
  scheme: string;
  schemeConfig: Record<string, string>;
  docsUrl?: string;
} {
  const [first] = entry.hosts;
  if (!first) throw new Error(`The directory's ${entry.slug} names no host`);
  return {
    vendor: entry.slug,
    displayName: entry.name,
    primaryHost: `https://${first}`,
    hosts: [...entry.hosts],
    scheme: entry.scheme,
    schemeConfig: {},
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
  };
}
