import { createContext, useContext, type Context } from "react";
import type { DraftKind } from "../draft-schema.ts";

export interface DraftPanelEntry {
  name: string | null;
  status: string;
  expanded: boolean;
  open: (() => void) | null;
  retry: (() => void) | null;
}

/** Transcript references get only an opener and an authorized summary, never a form copy. */
export interface DraftPanelScope {
  /** Drafts this conversation owns; a branch-copied reference is absent. */
  owned: ReadonlySet<string>;
  entries: ReadonlyMap<string, DraftPanelEntry>;
}

// One context per kind, so an agent widget and a schedule widget in the same
// chat each read their own owner, and both can nest without shadowing.
const emptyScope: DraftPanelScope = { owned: new Set(), entries: new Map() };
export const scopes: Record<DraftKind, Context<DraftPanelScope>> = {
  agent: createContext(emptyScope),
  schedule: createContext(emptyScope),
};
export const useDraftPanel = (kind: DraftKind, draftId: string) => {
  const scope = useContext(scopes[kind]);
  return { owned: scope.owned.has(draftId), entry: scope.entries.get(draftId) ?? null };
};
