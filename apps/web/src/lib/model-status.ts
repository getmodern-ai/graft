import type { Model } from "./model-key-queries";

/**
 * Which of four things the Settings screen's Model row says (GRA-297), from `GET /me/model`:
 * the person's own key where one is set and the deployment routes it, else the deployment's fixed
 * model, else a key is needed where one would be routed, else nothing builds tools here. Under the
 * open form with no fixed model a key changes nothing (ADR 0014; `apps/server/src/model.ts`), so
 * that state never says "Needs a key".
 */
export type ModelStatus = "included" | "own_key" | "needs_key" | "unconfigured";

export function modelStatusOf(
  model: Pick<Model, "fixed" | "personKeyAccepted" | "personKey">,
): ModelStatus {
  if (model.personKeyAccepted && model.personKey) return "own_key";
  if (model.fixed) return "included";
  return model.personKeyAccepted ? "needs_key" : "unconfigured";
}

/** The row's words for each state: the value beside the chip, when there is one, and the sentence under the title. */
export const MODEL_ROW_COPY = {
  included: { value: "Graft's model", description: "What writes your tools today." },
  own_key: { value: "Your key", description: "What writes your tools today." },
  needs_key: {
    value: null,
    description: "This deployment has no model of its own. Add your key below to build tools.",
  },
  unconfigured: {
    value: null,
    description:
      "This deployment has no model configured, so no tool can be built here until its operator sets one.",
  },
} as const satisfies Record<ModelStatus, { value: string | null; description: string }>;
