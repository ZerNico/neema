import { mergeSource } from "~/modules/tools/sources.ts";
import type { ToolSource } from "../client/use-message-stream.ts";

/** A source an earlier message registered, by its conversation-scoped citation number. */
export type InheritedSources = (index: number) => ToolSource | undefined;

export const NO_INHERITED_SOURCES: InheritedSources = () => undefined;

/**
 * Citation numbers are conversation-scoped, so a message may cite any source
 * an earlier message found. Each number keeps its merged history once, and a
 * message holds only a lookup bound to its position: copying every earlier
 * source into each message grew with the square of the conversation.
 */
export function inheritSources(
  perMessage: ReadonlyArray<ReadonlyArray<ToolSource>>,
): InheritedSources[] {
  // Entries per number, in message order, each merged with those before it.
  const history = new Map<number, Array<{ message: number; source: ToolSource }>>();
  const lookups: InheritedSources[] = [];
  perMessage.forEach((sources, message) => {
    lookups.push((index) => {
      const entries = history.get(index);
      if (!entries) return undefined;
      // The last entry recorded before this message.
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (entries[mid]!.message < message) low = mid + 1;
        else high = mid;
      }
      return low === 0 ? undefined : entries[low - 1]!.source;
    });
    for (const source of sources) {
      const entries = history.get(source.index) ?? [];
      const last = entries.at(-1);
      const merged = mergeSource(last?.source, source);
      if (last?.message === message) last.source = merged;
      else entries.push({ message, source: merged });
      history.set(source.index, entries);
    }
  });
  return lookups;
}
