import { AUTH_SCHEMES } from "@graft/proxy/types";
import { describe, expect, it } from "vitest";

import { validateHostSet, validateVendor } from "../connection/connection.rules";
import type { ProviderDescription } from "../connection/provider";
import {
  type CoveredStarter,
  STARTER_VENDOR_IDS,
  STARTER_VENDORS,
  type StarterVendor,
  setupBuildHints,
  setupVendorOptions,
  starterProposal,
  starterVendorFor,
  starterVendorOf,
} from "./starter-vendors";

const KEYRING: ProviderDescription = {
  name: "keyring",
  connect: { kind: "form", schemes: AUTH_SCHEMES },
};
const LINK: ProviderDescription = { name: "one-click", connect: { kind: "link" } };
const GATEWAY: ProviderDescription = { name: "gateway", connect: { kind: "none" } };

/** Every starter under one provider, or the provider a test names for some of them. */
function covered(
  pick: (starter: StarterVendor) => ProviderDescription = () => KEYRING,
): CoveredStarter[] {
  return STARTER_VENDORS.map((starter) => ({ starter, provider: pick(starter) }));
}

const ids = (list: ReturnType<typeof setupVendorOptions>) =>
  list.map((option) => option.starter.id);

describe("the starter integrations", () => {
  it("are the eight, each a vendor slug and a host set the connection rules admit", () => {
    expect(STARTER_VENDOR_IDS).toEqual([
      "gmail",
      "google-calendar",
      "google-drive",
      "slack",
      "notion",
      "github",
      "hubspot",
      "open-meteo",
    ]);
    for (const starter of STARTER_VENDORS) {
      expect(validateVendor(starter.vendor)).toBeNull();
      const hosts = validateHostSet(starter.primaryHost, starter.hosts);
      expect(hosts.ok).toBe(true);
      // The list names every host the calls reach, the primary's among them.
      if (hosts.ok) expect(new Set(hosts.hosts)).toEqual(new Set(starter.hosts));
      expect(starter.outcome).not.toMatch(/—/);
    }
  });

  it("keeps the curated task in the person's voice and the technical detail in the hints", () => {
    for (const starter of STARTER_VENDORS) {
      // What the person reads as their own goal: short, no field names, no instruction to a model.
      expect(starter.goal.length).toBeLessThanOrEqual(60);
      expect(starter.goal).toMatch(/^[A-Z]/);
      expect(starter.goal).not.toMatch(/[`—]|Read only|\.$/);
      // What the model is told beside it, when the person builds with it unchanged.
      expect(starter.hints).toMatch(/Read only\.$/);
      if (starter.runInput) expect(starter.hints).toContain(`\`${starter.runInput.field}\``);
    }
  });

  it("hints a Setup build with the curated detail only for the curated goal unchanged", () => {
    const meteo = starterVendorOf("open-meteo");
    if (!meteo) throw new Error("no open-meteo starter");
    const docs = "The vendor's documentation starts at https://open-meteo.com/en/docs.";
    expect(setupBuildHints(meteo, `  ${meteo.goal} `)).toBe(`${meteo.hints} ${docs}`);
    expect(setupBuildHints(meteo, "Show me tomorrow's forecast for Paris")).toBe(docs);
    expect(setupBuildHints(null, "List my tickets")).toBeNull();
  });

  it("asks for nothing the person has to look up: Open-Meteo's city has a default, the rest take no input", () => {
    expect(starterVendorOf("open-meteo")).toMatchObject({
      scheme: "none",
      hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
      runInput: { field: "city", defaultValue: "Melbourne" },
    });
    for (const starter of STARTER_VENDORS) {
      if (starter.runInput) {
        expect(starter.runInput.defaultValue.trim()).not.toBe("");
      } else {
        expect(starter.hints).toContain("The tool takes no input.");
      }
    }
    expect(STARTER_VENDORS.filter((starter) => starter.runInput).map((s) => s.id)).toEqual([
      "open-meteo",
    ]);
    // A spreadsheet's rows need its id and a range, both looked up (GRA-217): Drive lists files.
    expect(starterVendorOf("google-sheets")).toBeNull();
    expect(starterVendorOf("google-drive")).toMatchObject({
      vendor: "google-drive",
      primaryHost: "https://www.googleapis.com/drive/v3",
      hosts: ["www.googleapis.com"],
      runInput: null,
    });
    expect(starterVendorOf("gmail")?.runInput).toBeNull();
    expect(starterVendorOf("jira")).toBeNull();
    // Linear reads through GraphQL, a POST, which the check counts as a write (GRA-216).
    expect(starterVendorOf("linear")).toBeNull();
    expect(starterVendorFor("google-calendar")?.id).toBe("google-calendar");
    expect(starterVendorFor("acme")).toBeNull();
  });

  it("makes Gmail's task one call: the threads list, whose snippets need no read per message", () => {
    const gmail = starterVendorOf("gmail");
    expect(gmail?.goal).toBe("Show me my five latest inbox conversations");
    expect(gmail?.hints).toContain("threads list endpoint, one GET of `users/me/threads`");
    expect(gmail?.hints).toContain("`maxResults=5` and `labelIds=INBOX`");
    expect(gmail?.hints).toContain("`snippet`");
    expect(gmail?.hints).toContain("Make no other call.");
    expect(gmail?.hints).not.toMatch(/message get|metadataHeaders|then read each/);
  });

  it("proposes exactly what an agent's request_connection would send", () => {
    const github = starterVendorOf("github");
    if (!github) throw new Error("no github starter");
    expect(starterProposal(github)).toEqual({
      vendor: "github",
      displayName: "GitHub",
      primaryHost: "https://api.github.com",
      hosts: ["api.github.com"],
      scheme: "bearer",
      schemeConfig: {},
      docsUrl: "https://docs.github.com/en/rest",
    });
  });
});

describe("setupVendorOptions", () => {
  it("on the keyring alone offers Open-Meteo and nothing else: no key to paste, no client to register", () => {
    expect(setupVendorOptions(covered())).toEqual([
      { starter: starterVendorOf("open-meteo"), provider: "keyring", connect: "keyless" },
    ]);
  });

  it("leads with every starter a link provider covers, and Open-Meteo last", () => {
    const list = setupVendorOptions(
      covered((starter) => (starter.scheme === "none" ? KEYRING : LINK)),
    );
    expect(ids(list)).toEqual([
      "gmail",
      "google-calendar",
      "google-drive",
      "slack",
      "notion",
      "github",
      "hubspot",
      "open-meteo",
    ]);
    expect(list.slice(0, -1).every((option) => option.connect === "link")).toBe(true);
    expect(list.at(-1)).toMatchObject({ provider: "keyring", connect: "keyless" });
  });

  it("never offers a starter the keyring would connect with a pasted key or an OAuth client", () => {
    // A link provider that covers Gmail alone: the rest fall to the keyring's form.
    const list = setupVendorOptions(
      covered((starter) => (starter.vendor === "gmail" ? LINK : KEYRING)),
    );
    expect(ids(list)).toEqual(["gmail", "open-meteo"]);
    for (const option of list) expect(["link", "none", "keyless"]).toContain(option.connect);
  });

  it("orders link, then no step, then no key, the module's order within each", () => {
    const list = setupVendorOptions(
      covered((starter) =>
        starter.vendor === "github"
          ? GATEWAY
          : starter.vendor === "open-meteo" || starter.vendor === "hubspot"
            ? KEYRING
            : LINK,
      ),
    );
    expect(list.map((option) => `${option.starter.id}:${option.connect}`)).toEqual([
      "gmail:link",
      "google-calendar:link",
      "google-drive:link",
      "slack:link",
      "notion:link",
      "github:none",
      "open-meteo:keyless",
    ]);
  });

  it("drops Open-Meteo under a form provider that does not sign `none`", () => {
    const narrow: ProviderDescription = {
      name: "narrow",
      connect: { kind: "form", schemes: ["basic", "bearer"] },
    };
    expect(setupVendorOptions(covered(() => narrow))).toEqual([]);
  });
});
