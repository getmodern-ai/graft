import type { AuthScheme } from "@graft/proxy/types";

import type { ProviderDescription } from "../connection/provider";

/**
 * The **starter integrations** (CONTEXT.md; GRA-202; GRA-216; ADR 0024): the short list Setup's
 * integration step offers, each with a read-only task known to acquire cleanly and each connected
 * in one click. A convenience for the first tool, never a catalogue (ADR 0001): *Another
 * integration* is one click away and is the ordinary form. The code keeps the word vendor (the
 * connection's `vendor` slug, `STARTER_VENDORS`), as the model-facing text does; the person reads
 * integration.
 *
 * One entry per integration and nothing else to edit to add one. An entry carries what the connect
 * step proposes as the agent's own connection ask (`starterProposal`: the vendor, its hosts, the
 * documentation and the keyring's scheme and parameters for the form path), what the task step
 * pre-fills (`goal`, the person's words) and what the model is told beside it (`hints`, the
 * technical detail), what the run step asks for (`runInput`, with its default), and the one
 * sentence the integration step shows under the name (`outcome`).
 *
 * The list is **common services a link provider connects by OAuth** (Pipedream on Cloud, ADR
 * 0019), plus Open-Meteo, the keyless one, for a deployment where no link provider covers anything.
 * Every task is a GET: Setup's result step runs only a read-only tool, and the check counts a
 * `POST` as a write whatever it reads. That is why there is no Linear, whose API is GraphQL and
 * reads through `POST` alone.
 *
 * `scheme` is **the keyring's path**, kept truthful (a pasted token's scheme, or the vendor's own
 * authorization-code endpoints) though `setupVendorOptions` never offers it: a link provider
 * earlier in the order connects the vendor its own way, and the scheme matters only if that
 * provider steps aside to the form (GRA-147).
 *
 * **Browser-safe**: the console renders the step from the server's list, which is built from this
 * module, and nothing here imports more than a type.
 */

/** What the run step asks for before it runs the tool, with the value it starts at. */
export type StarterRunInput = {
  /** The input field the goal names, so the authored tool's schema and the run agree. */
  field: string;
  label: string;
  defaultValue: string;
};

export type StarterVendor = {
  id: string;
  /** The connection's vendor slug (`validateVendor`), and the tool's. */
  vendor: string;
  displayName: string;
  /** Where the API answers, with its version path: what a tool's relative fetch resolves against. */
  primaryHost: string;
  /** Every host tool calls reach, the primary's among them. */
  hosts: readonly string[];
  docsUrl: string;
  /** The keyring's scheme for the form path; `none` for a public API, which confirms with no key. */
  scheme: AuthScheme;
  schemeConfig: Readonly<Record<string, string>>;
  /**
   * The curated read-only task the task step pre-fills (GRA-207, GRA-216), in the person's voice:
   * short, in the first person, the way they would type it and the way the suggested tasks beside
   * it read (GRA-209). The technical detail is in `hints`, never here, since the person reads this
   * as their own task. `goal` in code, as the acquire job's field is.
   */
  goal: string;
  /**
   * What the model is told beside the curated goal: the input's field name, the endpoints, the
   * fields to return, and that the tool reads only. Handed to the job as its `hints` only when the
   * person builds with `goal` unchanged (`setupBuildHints`); a goal of their own is not this one.
   */
  hints: string;
  /** The run's one input, or null for a tool that takes none. */
  runInput: StarterRunInput | null;
  /** What the person will see once the tool runs, one sentence, for the integration step. */
  outcome: string;
};

const GOOGLE_OAUTH = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
} as const;

export const STARTER_VENDORS = [
  {
    id: "gmail",
    vendor: "gmail",
    displayName: "Gmail",
    primaryHost: "https://gmail.googleapis.com/gmail/v1",
    hosts: ["gmail.googleapis.com"],
    docsUrl: "https://developers.google.com/workspace/gmail/api/reference/rest",
    scheme: "oauth_authorization_code",
    schemeConfig: {
      ...GOOGLE_OAUTH,
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    },
    goal: "Show me my five latest emails",
    hints:
      "List the five most recent messages in the inbox, with the sender, the subject and the date of each. Read only.",
    runInput: null,
    outcome: "Your five latest emails, with who sent each one and its subject.",
  },
  {
    id: "google-calendar",
    vendor: "google-calendar",
    displayName: "Google Calendar",
    primaryHost: "https://www.googleapis.com/calendar/v3",
    hosts: ["www.googleapis.com"],
    docsUrl: "https://developers.google.com/workspace/calendar/api/v3/reference",
    scheme: "oauth_authorization_code",
    schemeConfig: {
      ...GOOGLE_OAUTH,
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
    },
    goal: "Show me what is on my calendar this week",
    hints:
      "List the events on the primary calendar for the next seven days, with the title, the start time and the location of each. Read only.",
    runInput: null,
    outcome: "Your week ahead: each event's title, when it starts and where.",
  },
  {
    id: "google-sheets",
    vendor: "google-sheets",
    displayName: "Google Sheets",
    primaryHost: "https://sheets.googleapis.com/v4",
    hosts: ["sheets.googleapis.com"],
    docsUrl: "https://developers.google.com/workspace/sheets/api/reference/rest",
    scheme: "oauth_authorization_code",
    schemeConfig: {
      ...GOOGLE_OAUTH,
      scopes: "https://www.googleapis.com/auth/spreadsheets.readonly",
    },
    goal: "Show me the first rows of a spreadsheet I choose",
    hints:
      "The tool takes a spreadsheet's link or its id as the input `spreadsheet`, reads the id from between `/d/` and the next slash when it is a link, and returns the spreadsheet's title, the first sheet's name and that sheet's first ten rows. Read only.",
    // Google's own sample spreadsheet, readable by any Google account, so the first run has rows.
    runInput: {
      field: "spreadsheet",
      label: "Spreadsheet link",
      defaultValue:
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    },
    outcome: "The first rows of a spreadsheet you choose, starting with a sample one.",
  },
  {
    id: "slack",
    vendor: "slack",
    displayName: "Slack",
    primaryHost: "https://slack.com/api",
    hosts: ["slack.com"],
    docsUrl: "https://docs.slack.dev/reference/methods/",
    scheme: "oauth_authorization_code",
    schemeConfig: {
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: "channels:read",
    },
    goal: "List the public channels in my workspace",
    hints:
      "List the public channels in the Slack workspace, with the name, the topic and the member count of each. Read only.",
    runInput: null,
    outcome: "Your workspace's public channels, with each one's topic and member count.",
  },
  {
    id: "notion",
    vendor: "notion",
    displayName: "Notion",
    primaryHost: "https://api.notion.com/v1",
    hosts: ["api.notion.com"],
    docsUrl: "https://developers.notion.com/reference/intro",
    // An internal integration's secret, sent as a bearer token; the form path's truth.
    scheme: "bearer",
    schemeConfig: {},
    // Notion lists pages only through its search, a POST, which the check counts as a write, and
    // Setup's result step runs only a read-only tool: the users list is a GET.
    goal: "Show me the people in my Notion workspace",
    hints:
      "List the users of the Notion workspace with the users list endpoint, a GET, with the name and the type (person or bot) of each, sending the `Notion-Version` header the documentation names. Read only.",
    runInput: null,
    outcome: "The people in your Notion workspace, and which of them are bots.",
  },
  {
    id: "github",
    vendor: "github",
    displayName: "GitHub",
    primaryHost: "https://api.github.com",
    hosts: ["api.github.com"],
    docsUrl: "https://docs.github.com/en/rest",
    // A personal access token, sent as a bearer token; the form path's truth.
    scheme: "bearer",
    schemeConfig: {},
    goal: "Show me the repositories I updated most recently",
    hints:
      "List the authenticated user's ten most recently updated repositories, with the name, the description, the main language and the star count of each. Read only.",
    runInput: null,
    outcome: "Your ten most recently updated repositories, with their language and stars.",
  },
  {
    id: "hubspot",
    vendor: "hubspot",
    displayName: "HubSpot",
    primaryHost: "https://api.hubapi.com",
    hosts: ["api.hubapi.com"],
    docsUrl: "https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide",
    // A private app's access token, sent as a bearer token; the form path's truth.
    scheme: "bearer",
    schemeConfig: {},
    // The contacts search is a POST, which the check counts as a write: the list is a GET.
    goal: "Show me ten contacts from my CRM",
    hints:
      "List ten contacts with the contacts list endpoint, a GET and not the search, asking for the `firstname`, `lastname`, `email` and `company` properties and returning those for each. Read only.",
    runInput: null,
    outcome: "Ten contacts from your CRM, with each one's email and company.",
  },
  {
    id: "open-meteo",
    vendor: "open-meteo",
    displayName: "Open-Meteo",
    primaryHost: "https://api.open-meteo.com/v1",
    // The forecast and the geocoding API are two hosts of one public vendor.
    hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    docsUrl: "https://open-meteo.com/en/docs",
    scheme: "none",
    schemeConfig: {},
    goal: "Tell me the weather right now in a city I name",
    hints:
      "The tool takes a city name as the input `city`, looks up the city's coordinates with Open-Meteo's geocoding API, and returns the current temperature, wind speed and weather there. Read only.",
    runInput: { field: "city", label: "City", defaultValue: "Melbourne" },
    outcome: "The weather right now in a city you choose, with no key to enter.",
  },
] as const satisfies readonly StarterVendor[];

export type StarterVendorId = (typeof STARTER_VENDORS)[number]["id"];

export const STARTER_VENDOR_IDS = STARTER_VENDORS.map((starter) => starter.id) as [
  StarterVendorId,
  ...StarterVendorId[],
];

/** Whether a value is one of the starters' ids: what the connect route's body admits. */
export function isStarterVendorId(value: string): value is StarterVendorId {
  return (STARTER_VENDOR_IDS as readonly string[]).includes(value);
}

/** The starter by its id, or null for one this deployment's list never had. */
export function starterVendorOf(id: string): StarterVendor | null {
  return STARTER_VENDORS.find((starter) => starter.id === id) ?? null;
}

/**
 * The starter a connection is of, by its vendor slug, or null for another vendor: how a later step
 * (the goal's pre-filled text, the run's input) finds the starter from the record's connection
 * alone, whichever way the connection was made.
 */
export function starterVendorFor(vendor: string): StarterVendor | null {
  return STARTER_VENDORS.find((starter) => starter.vendor === vendor) ?? null;
}

/**
 * The `hints` a Setup build hands its job, as an agent would hint one: for a starter, where its
 * documentation starts, and before that the starter's own `hints` when the goal is its curated one
 * unchanged, since a goal the person wrote may ask for something the curated detail would contradict.
 * Null for another vendor, whose model finds its own documentation.
 */
export function setupBuildHints(starter: StarterVendor | null, goal: string): string | null {
  if (!starter) return null;
  const docs = `The vendor's documentation starts at ${starter.docsUrl}.`;
  return goal.trim() === starter.goal ? `${starter.hints} ${docs}` : docs;
}

/**
 * The starter as the connection proposal the connect step makes as the agent (`@graft/mcp`'s
 * `ConnectionProposalInput`, structurally): exactly what an agent's `request_connection` would
 * send, so the routing, the ask and the card are the ones an agent's proposal gets.
 */
export function starterProposal(starter: StarterVendor): {
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts: string[];
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  docsUrl: string;
} {
  return {
    vendor: starter.vendor,
    displayName: starter.displayName,
    primaryHost: starter.primaryHost,
    hosts: [...starter.hosts],
    scheme: starter.scheme,
    schemeConfig: { ...starter.schemeConfig },
    docsUrl: starter.docsUrl,
  };
}

/**
 * What the connect step will draw for a starter on this deployment, and every kind is one click:
 * - `link`: the provider's one-click link (ADR 0019);
 * - `none`: a provider with no person step connects it at once (the gateway, GRA-58);
 * - `keyless`: the keyring's confirmation of a public API, nothing entered (GRA-66).
 *
 * There is no kind for the secret form: a starter the deployment could connect only with a pasted
 * key or an operator's own OAuth client is never offered (GRA-216). *Another integration* is the
 * form, for a person who has a key in hand.
 */
export type SetupConnectKind = "link" | "none" | "keyless";

/** One line of the integration step: the starter, the provider that covers it, and what connecting takes. */
export type SetupVendorOption = {
  starter: StarterVendor;
  provider: string;
  connect: SetupConnectKind;
};

/** A starter beside the provider `providerFor` routes its proposal to, which the server decides. */
export type CoveredStarter = { starter: StarterVendor; provider: ProviderDescription };

/** Lower leads: one click through a link first, then no step, then no key. */
const CONNECT_RANK: Record<SetupConnectKind, number> = { link: 0, none: 1, keyless: 2 };

function connectKindOf({ starter, provider }: CoveredStarter): SetupConnectKind | null {
  const { connect } = provider;
  if (connect.kind === "link" || connect.kind === "none") return connect.kind;
  // A form provider offers the starter only where there is nothing to enter: a public API, and
  // only when the provider signs `none`. A key to paste, or a client to register for an
  // authorization-code scheme (ADR 0005), is not a first five minutes.
  return starter.scheme === "none" && connect.schemes.includes("none") ? "keyless" : null;
}

/**
 * The integration step's list for this deployment, from each starter's covering provider (the
 * server asks `providerFor` in `Backings.providers` order, since coverage is async and may be a
 * catalogue's; the console never computes it): only a starter that connects in one click is kept,
 * and the rest are ordered by how little connecting takes, so the link provider's starters lead
 * where the deployment has one and Open-Meteo stands alone where the keyring is. Within a kind the
 * module's order stands.
 */
export function setupVendorOptions(covered: readonly CoveredStarter[]): SetupVendorOption[] {
  const options: { option: SetupVendorOption; index: number }[] = [];
  covered.forEach((entry, index) => {
    const connect = connectKindOf(entry);
    if (connect) {
      options.push({
        option: { starter: entry.starter, provider: entry.provider.name, connect },
        index,
      });
    }
  });
  return options
    .sort(
      (a, b) =>
        CONNECT_RANK[a.option.connect] - CONNECT_RANK[b.option.connect] || a.index - b.index,
    )
    .map(({ option }) => option);
}
