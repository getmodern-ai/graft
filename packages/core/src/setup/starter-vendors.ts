import type { AuthScheme } from "@graft/proxy/types";

import type { ProviderDescription } from "../connection/provider";

/**
 * The **starter vendors** (CONTEXT.md; GRA-202, *Starter vendors*; ADR 0024): the short list
 * Setup's vendor step offers, each with a read-only goal known to acquire cleanly. A convenience
 * for the first tool, never a catalogue (ADR 0001): *Another vendor* is one click away and is the
 * ordinary form.
 *
 * One entry per vendor and nothing else to edit to add one. An entry carries what the connect step
 * proposes as the agent's own connection ask (`starterProposal`: the vendor, its hosts, the
 * documentation and the keyring's scheme and parameters for the form path), what the goal step
 * pre-fills (`goal`, the person's words) and what the model is told beside it (`hints`, the
 * technical detail), what the run step asks for (`runInput`, with its default), and the one
 * sentence the vendor step shows under the name (`outcome`).
 *
 * `scheme` is **the keyring's path**, the one a deployment with no other provider connects
 * through. A provider earlier in the order may connect the vendor its own way (a link, ADR 0019),
 * and then the scheme only matters if that provider steps aside to the form (GRA-147).
 * `setupVendorOptions` drops a starter whose only path is the keyring's form over an
 * authorization-code scheme, which would need an OAuth client of the operator's own (ADR 0005).
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
   * The curated read-only goal the goal step pre-fills (GRA-207), in the person's voice: short, in
   * the first person, the way they would type it and the way the suggested goals beside it read
   * (GRA-209). The technical detail is in `hints`, never here, since the person reads this as
   * their own goal.
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
  /** What the person will see once the tool runs, one sentence, for the vendor step. */
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
    scheme: "bearer",
    schemeConfig: {},
    goal: "Show me the pages I edited most recently",
    hints:
      "List the ten pages shared with this integration that were edited most recently, with the title and the last edited time of each. Read only.",
    runInput: null,
    outcome: "The ten pages edited most recently, with when each one changed.",
  },
  {
    id: "github",
    vendor: "github",
    displayName: "GitHub",
    primaryHost: "https://api.github.com",
    hosts: ["api.github.com"],
    docsUrl: "https://docs.github.com/en/rest",
    scheme: "bearer",
    schemeConfig: {},
    goal: "Show me the repositories I updated most recently",
    hints:
      "List the authenticated user's ten most recently updated repositories, with the name, the description, the main language and the star count of each. Read only.",
    runInput: null,
    outcome: "Your ten most recently updated repositories, with their language and stars.",
  },
  {
    id: "linear",
    vendor: "linear",
    displayName: "Linear",
    primaryHost: "https://api.linear.app",
    hosts: ["api.linear.app"],
    docsUrl: "https://linear.app/developers/graphql",
    // A personal API key goes in `Authorization` as it is, with no `Bearer` in front.
    scheme: "api_key_header",
    schemeConfig: { headerName: "Authorization" },
    goal: "Show me the open issues assigned to me",
    hints:
      "List the issues assigned to the authenticated user that are not completed or cancelled, with the identifier, the title, the state and the priority of each. Read only.",
    runInput: null,
    outcome: "The open issues assigned to you, with each one's state and priority.",
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
 * What the connect step will draw for a starter on this deployment:
 * - `link`: the provider's one-click link (ADR 0019);
 * - `none`: a provider with no person step connects it at once (the gateway, GRA-58);
 * - `keyless`: the keyring's confirmation of a public API, nothing entered (GRA-66);
 * - `form`: the secret form, pre-filled with the host and the scheme.
 */
export type SetupConnectKind = "link" | "none" | "keyless" | "form";

/** One line of the vendor step: the starter, the provider that covers it, and what connecting takes. */
export type SetupVendorOption = {
  starter: StarterVendor;
  provider: string;
  connect: SetupConnectKind;
};

/** A starter beside the provider `providerFor` routes its proposal to, which the server decides. */
export type CoveredStarter = { starter: StarterVendor; provider: ProviderDescription };

/** Lower leads: one click first, then no step, then no key, then a key to paste. */
const CONNECT_RANK: Record<SetupConnectKind, number> = { link: 0, none: 1, keyless: 2, form: 3 };

function connectKindOf({ starter, provider }: CoveredStarter): SetupConnectKind | null {
  const { connect } = provider;
  if (connect.kind === "link" || connect.kind === "none") return connect.kind;
  // A form provider that does not sign the starter's scheme cannot connect it, `none` included.
  if (!connect.schemes.includes(starter.scheme)) return null;
  if (starter.scheme === "none") return "keyless";
  // The form over an authorization-code scheme needs a client the operator registered (ADR 0005):
  // not a first five minutes, so the starter is left off rather than offered and stalled.
  if (starter.scheme === "oauth_authorization_code") return null;
  return "form";
}

/**
 * The vendor step's list for this deployment, from each starter's covering provider (the server
 * asks `providerFor` in `Backings.providers` order, since coverage is async and may be a
 * catalogue's; the console never computes it): a starter with no path short of an operator's own
 * OAuth client is dropped, and the rest are ordered by how little connecting takes, so a
 * one-click starter leads where the deployment has one and Open-Meteo leads where the keyring is
 * alone. Within a kind the module's order stands.
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
