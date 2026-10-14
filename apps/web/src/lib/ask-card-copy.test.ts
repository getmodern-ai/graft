import * as card from "@graft/ask-card/copy";
import type { AuthScheme } from "@graft/proxy/types";
import { describe, expect, it } from "vitest";

import { accessLegend, accessOptions, DEFAULT_ACCESS_CHOICE } from "./access-choice";
import { SCHEME_LABELS } from "./connection-form";
import { type ProposalFinish, proposalLead, proposalSummary } from "./handoff-copy";
import {
  defaultToolAllowChoice,
  type ToolAllowChoice,
  toolAllowAnswer,
  toolAllowOptions,
  toolLabel,
} from "./tool-allow-choice";

/**
 * The ask card asks the handoff page's questions with its choices (GRA-316), but it is one inlined
 * page that imports nothing, so `@graft/ask-card/copy` holds a copy of each helper here. This is
 * where the copies are held to the originals: a change to the page's words or choices that the
 * card did not take is a red test, not a card that quietly says something else.
 */
describe("the ask card's copy of the handoff page's words", () => {
  const people = [
    ["Claude", "Gmail"],
    ["Hermes", "Acme Unleashed"],
  ] as const;

  it("offers Full access and Ask me first in the page's words, the same one pre-selected", () => {
    expect(card.DEFAULT_ACCESS_CHOICE).toBe(DEFAULT_ACCESS_CHOICE);
    for (const [agent, integration] of people) {
      expect(card.accessOptions(agent, integration)).toEqual(accessOptions(agent, integration));
      expect(card.accessLegend(agent)).toBe(accessLegend(agent));
    }
  });

  it("offers a tool ask's choices in the page's words and order, the same one pre-selected", () => {
    for (const destructive of [false, true]) {
      const input = {
        agentName: "Codex",
        integrationName: "Gmail",
        tool: "Send email",
        destructive,
      };
      expect(card.toolAllowOptions(input)).toEqual(toolAllowOptions(input));
      expect(card.defaultToolAllowChoice(destructive)).toBe(defaultToolAllowChoice(destructive));
    }
    for (const [name, vendor] of [
      ["gmail__send-email", "gmail"],
      ["demo__create_order", "demo"],
      ["other__x", "demo"],
      ["gmail__", "gmail"],
    ]) {
      expect(card.toolLabel(name as string, vendor as string)).toBe(
        toolLabel(name as string, vendor as string),
      );
    }
  });

  it("sends what the page sends for each tool choice, less the ask-every-call tick the card never carries", () => {
    const choices: ToolAllowChoice[] = ["integration", "tool", "integration-destructive"];
    for (const choice of choices) {
      expect(card.toolAllowAnswer(choice)).toEqual(toolAllowAnswer(choice));
    }
  });

  it("words a connection's lead and summary as the page does", () => {
    const finishes: ProposalFinish[] = ["key", "consent", "link", "keyless", "widen"];
    for (const finish of finishes) {
      for (const docsUrl of [null, "https://docs.acme.example"]) {
        const input = {
          agentName: "Hermes",
          integrationName: "Acme",
          docsUrl,
          finish,
          provider: "Broker",
          addedHosts: ["eu.acme.example"],
        };
        expect(card.proposalLead(input)).toBe(proposalLead(input));
      }
    }
    for (const provider of [undefined, "Broker"]) {
      const input = {
        primaryHost: "https://api.acme.example/v1",
        scheme: "api_key_header",
        integrationName: "Acme",
        docsUrl: "https://docs.acme.example",
        ...(provider ? { provider } : {}),
      };
      expect(
        card.proposalSummary({
          ...input,
          schemeLabel: (scheme) => SCHEME_LABELS[scheme as AuthScheme] ?? scheme,
        }),
      ).toBe(proposalSummary(input));
    }
  });
});
