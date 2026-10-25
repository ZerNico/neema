import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

type LossKind = "document" | "agentDraft" | "scheduleDraft" | "workingFile";

/** Each kind's own sentences, since its noun's gender changes the German around it. */
const WORDS: Record<
  LossKind,
  {
    named: (inputs: { name: string }) => string;
    untitled: () => string;
    count: (inputs: { count: number }) => string;
  }
> = {
  document: {
    named: m.chat_loss_document_named,
    untitled: m.chat_loss_document_untitled,
    count: m.chat_loss_document_count,
  },
  agentDraft: {
    named: m.chat_loss_agent_draft_named,
    untitled: m.chat_loss_agent_draft_untitled,
    count: m.chat_loss_agent_draft_count,
  },
  scheduleDraft: {
    named: m.chat_loss_schedule_draft_named,
    untitled: m.chat_loss_schedule_draft_untitled,
    count: m.chat_loss_schedule_draft_count,
  },
  workingFile: {
    named: m.chat_loss_working_file_named,
    untitled: m.chat_loss_working_file_untitled,
    count: m.chat_loss_working_file_count,
  },
};

/**
 * " The document “Plan” will also be deleted." for one casualty; counts per
 * kind for several. Empty when a rewind takes nothing of the sort.
 */
export function lossSentence(items: ReadonlyArray<{ kind: LossKind; name: string }>) {
  if (items.length === 0) return "";
  if (items.length === 1) {
    const [item] = items;
    const words = WORDS[item!.kind];
    return ` ${item!.name ? words.named({ name: item!.name }) : words.untitled()}`;
  }
  const counts = new Map<LossKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => WORDS[kind].count({ count }));
  const list = new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(parts);
  return ` ${m.chat_loss_several({ list })}`;
}
