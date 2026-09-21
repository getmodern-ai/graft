import type { AgentScopeMode } from "@graft/core";
import type { ScopeBody } from "@graft/server/api";

/**
 * The scope's mode as the console says it (CONTEXT.md, *Scope*; ADR 0007 as amended 2026-09-19):
 * `all` is every connection of the person's, present and future, and is what a new agent starts
 * on; `listed` is the picker. One map per vocabulary, as `status-chips.ts` does, so the create
 * dialog, the consent card and the agent page's Scope section never spell a label twice. Labels
 * are sentence case, like every label in the console.
 */
export const SCOPE_MODE_LABEL: Record<AgentScopeMode, string> = {
  all: "All connections",
  listed: "Selected connections",
};

/** The `Select`'s `items`, in the order the choice is offered: the default first. */
export const SCOPE_MODE_ITEMS: readonly { value: AgentScopeMode; label: string }[] = [
  { value: "all", label: SCOPE_MODE_LABEL.all },
  { value: "listed", label: SCOPE_MODE_LABEL.listed },
];

/**
 * The sentence under the choice explains which connections are in scope. Selecting all does
 * not answer the build or tool approvals (ADR 0008).
 */
export const SCOPE_MODE_DESCRIPTION: Record<AgentScopeMode, string> = {
  all: "This agent can use every connection you have now or add later. Creating tools and making changes still require approval.",
  listed: "This agent can only use the connections you select below. You can change this later.",
};

/** A string from a `Select` read back as a mode, or null for anything that is not one. */
export function readScopeMode(value: unknown): AgentScopeMode | null {
  return value === "all" || value === "listed" ? value : null;
}

/**
 * What `PUT /api/agents/:id/scope` is sent for a mode and the picker's draft: `all` carries no
 * list — the server clears the one it had — and `listed` carries the draft as the list, so the
 * server never has to guess what the person saw ticked.
 */
export function scopeBodyFor(mode: AgentScopeMode, draft: ReadonlySet<string>): ScopeBody {
  return mode === "all" ? { mode: "all" } : { mode: "listed", connectionIds: [...draft] };
}

/**
 * Whether the Scope section has something to save: the mode changed, or under `listed` the set
 * did. Under `all` the picker is not shown, so its draft is not a change whatever it holds.
 */
export function scopeDirty(
  saved: { mode: AgentScopeMode; connectionIds: ReadonlySet<string> },
  draft: { mode: AgentScopeMode; connectionIds: ReadonlySet<string> },
): boolean {
  if (saved.mode !== draft.mode) return true;
  if (draft.mode === "all") return false;
  return (
    saved.connectionIds.size !== draft.connectionIds.size ||
    [...saved.connectionIds].some((id) => !draft.connectionIds.has(id))
  );
}
