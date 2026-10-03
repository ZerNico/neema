import type { Capabilities } from "~/modules/providers/ui/capability-icons.tsx";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";

export interface PickableModel {
  id: string;
  displayName: string;
  /** The admin's plain-words note; optional so callers without it still fit. */
  description?: string | null;
  providerName: string;
  contextLength: number | null;
  capabilities: Capabilities | null;
  reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
}

// Lower is better. A name hit outranks a provider or description hit, and the
// start of a name outranks its middle, so "gpt" puts GPT models above a model
// whose description mentions GPT.
const score = (model: PickableModel, phrase: string, words: string[]): number | null => {
  const name = model.displayName.toLowerCase();
  const haystack = `${name} ${model.providerName} ${model.description ?? ""}`.toLowerCase();
  if (!words.every((word) => haystack.includes(word))) return null;
  if (name === phrase) return 0;
  if (name.startsWith(phrase)) return 1;
  if (name.split(/[\s\-_./:]+/).some((part) => part.startsWith(phrase))) return 2;
  if (name.includes(phrase)) return 3;
  if (words.every((word) => name.includes(word))) return 4;
  return 5;
};

/** Matches best first; ties keep the admin's order. */
export function rankModels(models: readonly PickableModel[], query: string): PickableModel[] {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return [...models];
  const words = phrase.split(" ");
  return (
    models
      .map((model, index) => ({ model, index, score: score(model, phrase, words) }))
      .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
      // Sorting a fresh array; the client targets ES2022, before toSorted.
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((entry) => entry.model)
  );
}
