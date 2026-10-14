/**
 * The **integration directory** (Setup v2's integration step; ADR 0001 as amended 2026-10-10): the
 * integrations a deployment can connect, searchable, with their marks and categories, so the step
 * can say "connect Graft to anything" and mean what this deployment covers. A seam with two
 * backings (ADR 0002): the open form's is the starter integrations (`apps/server/src/directory.ts`),
 * and the hosted form's is its link provider's catalogue, in the private package. Nothing here names
 * a vendor of Graft's.
 *
 * An entry is enough to propose a connection (`request_connection`'s shape, through the same
 * routing): the slug is the connection's vendor slug, and the hosts are where the backing knows the
 * integration's API answers, which the provider that covers it will judge again. A directory lists
 * integrations; it is never a catalogue of someone else's tools, and choosing one still builds the
 * tool through `acquire` (ADR 0001).
 *
 * **Browser-safe**: the console renders the wire shapes, and nothing here imports more than a type.
 */

/** How an entry is connected on this deployment, which the card says in a few words. */
export type DirectoryConnectKind = "link" | "keyless" | "form";

export type DirectoryEntry = {
  /** The vendor slug a connection to it carries (`validateVendor`). */
  slug: string;
  name: string;
  /** One line on what it is, the backing's own words, or null. */
  description: string | null;
  /** An absolute https URL of its mark, or null for none (the console draws a glyph). */
  logoUrl: string | null;
  categories: string[];
  /** Where its API answers: the first is the primary host, as `https://<host>`. */
  hosts: string[];
  /** Where its documentation starts, when the backing knows; the model finds it otherwise. */
  docsUrl: string | null;
  connect: DirectoryConnectKind;
  /**
   * The keyring's scheme for the form path a link provider steps aside to (GRA-147), as the
   * starters carry theirs: a pasted token where the backing knows no better.
   */
  scheme: string;
};

export type DirectoryCategory = { name: string; count: number };

/** The integration step's first view: what to show before anyone searches. */
export type DirectoryHome = {
  /** How many integrations the directory holds, for "3,000 integrations in the directory". */
  total: number;
  categories: DirectoryCategory[];
  /** The most connected, for the grid under *Popular*, in the backing's order. */
  popular: DirectoryEntry[];
  /** Marks for the logo wall: the next most connected after `popular`, with a logo each. */
  wall: Pick<DirectoryEntry, "slug" | "name" | "logoUrl">[];
};

export type DirectorySearchInput = {
  /** Words to match against the name, the slug and the description; empty lists by popularity. */
  query?: string;
  /** One of `DirectoryHome.categories`' names. */
  category?: string;
  /** The page after the one that answered it, opaque. */
  cursor?: string;
  limit: number;
};

export type DirectoryPage = {
  entries: DirectoryEntry[];
  nextCursor: string | null;
  /** How many match in all, for "46 integrations match". */
  total: number;
};

export type IntegrationDirectory = {
  /** The backing's name, for the boot line. */
  name: string;
  home(): Promise<DirectoryHome>;
  search(input: DirectorySearchInput): Promise<DirectoryPage>;
  /** One entry by slug, or null when the directory has none: the task route reads it to connect. */
  get(slug: string): Promise<DirectoryEntry | null>;
};

/** The largest page a caller may ask for. */
export const DIRECTORY_PAGE_LIMIT = 48;
