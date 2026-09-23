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

describe("the starter vendors", () => {
  it("are the seven, each a vendor slug and a host set the connection rules admit", () => {
    expect(STARTER_VENDOR_IDS).toEqual([
      "gmail",
      "google-calendar",
      "slack",
      "notion",
      "github",
      "linear",
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

  it("keeps the curated goal in the person's voice and the technical detail in the hints", () => {
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

  it("gives Open-Meteo a city with Melbourne as its default, and Gmail no input", () => {
    expect(starterVendorOf("open-meteo")).toMatchObject({
      scheme: "none",
      hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
      runInput: { field: "city", defaultValue: "Melbourne" },
    });
    expect(starterVendorOf("gmail")?.runInput).toBeNull();
    expect(starterVendorOf("jira")).toBeNull();
    expect(starterVendorFor("google-calendar")?.id).toBe("google-calendar");
    expect(starterVendorFor("acme")).toBeNull();
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
  it("on the keyring alone, drops the three that need an OAuth client and leads with Open-Meteo", () => {
    const list = setupVendorOptions(covered());
    expect(ids(list)).toEqual(["open-meteo", "notion", "github", "linear"]);
    expect(list[0]).toMatchObject({ provider: "keyring", connect: "keyless" });
    expect(list.slice(1).every((option) => option.connect === "form")).toBe(true);
  });

  it("puts a one-click starter first, and keeps Gmail once a link provider covers it", () => {
    const list = setupVendorOptions(
      covered((starter) => (starter.vendor === "gmail" ? LINK : KEYRING)),
    );
    expect(ids(list)).toEqual(["gmail", "open-meteo", "notion", "github", "linear"]);
    expect(list[0]).toMatchObject({ provider: "one-click", connect: "link" });
  });

  it("orders link, then no step, then no key, then a key, the module's order within each", () => {
    const list = setupVendorOptions(
      covered((starter) =>
        starter.vendor === "github"
          ? GATEWAY
          : starter.vendor === "open-meteo" || starter.vendor === "linear"
            ? KEYRING
            : LINK,
      ),
    );
    expect(list.map((option) => `${option.starter.id}:${option.connect}`)).toEqual([
      "gmail:link",
      "google-calendar:link",
      "slack:link",
      "notion:link",
      "github:none",
      "open-meteo:keyless",
      "linear:form",
    ]);
  });

  it("drops a starter a form provider cannot sign", () => {
    const narrow: ProviderDescription = {
      name: "narrow",
      connect: { kind: "form", schemes: ["basic"] },
    };
    const list = setupVendorOptions(
      covered((starter) => (starter.vendor === "github" ? narrow : KEYRING)),
    );
    expect(ids(list)).not.toContain("github");
  });
});
