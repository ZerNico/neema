/**
 * " The document “Plan” will also be deleted." for one casualty; counts per
 * kind for several. Empty when a rewind takes nothing of the sort.
 */
export function lossSentence(items: ReadonlyArray<{ noun: string; name: string }>) {
  if (items.length === 0) return "";
  if (items.length === 1) {
    const [item] = items;
    return item!.name
      ? ` The ${item!.noun} “${item!.name}” will also be deleted.`
      : ` An untitled ${item!.noun} will also be deleted.`;
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.noun, (counts.get(item.noun) ?? 0) + 1);
  const parts = [...counts].map(([noun, count]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return ` ${list} will also be deleted.`;
}
