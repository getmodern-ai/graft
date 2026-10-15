import { describe, expect, it } from "vitest";

import { MODEL_ROW_COPY, modelStatusOf, ownKeyModels } from "./model-status";
import { MODEL_STATUS_CHIP } from "./status-chips";

describe("modelStatusOf", () => {
  it("says Graft's model where the deployment has a fixed one and the person no key", () => {
    expect(modelStatusOf({ fixed: true, personKeyAccepted: true, personKey: false })).toBe(
      "included",
    );
  });

  it("says the person's own key wherever the deployment routes one, fixed model or not", () => {
    expect(modelStatusOf({ fixed: true, personKeyAccepted: true, personKey: true })).toBe(
      "own_key",
    );
    expect(modelStatusOf({ fixed: false, personKeyAccepted: true, personKey: true })).toBe(
      "own_key",
    );
  });

  it("needs a key under the hosted form with no fixed model", () => {
    expect(modelStatusOf({ fixed: false, personKeyAccepted: true, personKey: false })).toBe(
      "needs_key",
    );
  });

  it("is unconfigured under the open form with no model, where even a stored key is not used", () => {
    expect(modelStatusOf({ fixed: false, personKeyAccepted: false, personKey: false })).toBe(
      "unconfigured",
    );
    expect(modelStatusOf({ fixed: false, personKeyAccepted: false, personKey: true })).toBe(
      "unconfigured",
    );
  });

  it("has a chip and the row's words for every state, the Figma row's for the included one", () => {
    expect(Object.keys(MODEL_ROW_COPY).sort()).toEqual(Object.keys(MODEL_STATUS_CHIP).sort());
    expect(MODEL_ROW_COPY.included.value).toBe("Graft's model");
    expect(MODEL_STATUS_CHIP.included.label).toBe("Included");
    for (const copy of Object.values(MODEL_ROW_COPY)) {
      expect(copy.description).not.toContain("—");
    }
  });
});

describe("ownKeyModels", () => {
  it("names the provider's defaults where the key leaves the models blank", () => {
    expect(ownKeyModels({ authoringModel: null, triageModel: null, baseUrl: null })).toBe(
      "Writes with the provider's default, reads docs with the provider's default.",
    );
  });

  it("names the models and the gateway the key is for", () => {
    expect(
      ownKeyModels({
        authoringModel: "gpt-x",
        triageModel: "gpt-mini",
        baseUrl: "https://gw.test/v1",
      }),
    ).toBe("Writes with gpt-x, reads docs with gpt-mini. Through https://gw.test/v1.");
  });
});
